//! libp2p swarm: Gossipsub + Kademlia DHT + mDNS + Identify over TCP/Noise/Yamux.
//!
//! The swarm runs in a dedicated tokio task and is bridged to the HTTP layer
//! through two channels:
//!   - `P2PCommand`  : control messages (publish a record, dial a peer)
//!   - `GossipEvent` : incoming gossipsub messages; the HTTP layer verifies &
//!     stores them and pushes them out to browser clients over /ws/events.

use std::collections::HashSet;

use futures::StreamExt;
use libp2p::gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode};
use libp2p::identify::{self, Event as IdentifyEvent};
use libp2p::kad::{record::store::MemoryStore, Behaviour as Kademlia, Event as KademliaEvent, QueryResult};
use libp2p::mdns;
use libp2p::multiaddr::Protocol;
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{
    identity, noise, tcp, yamux, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// Application-level topic used to gossip signed records across the network.
pub const RECORDS_TOPIC: &str = "ddn/records/v1";

/// Dedicated topic for WebRTC signaling messages (SDP offer/answer, ICE candidates).
pub const WEBRTC_SIGNAL_TOPIC: &str = "ddn/webrtc/v1";

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

#[derive(NetworkBehaviour)]
struct DdnBehaviour {
    gossipsub: gossipsub::Behaviour,
    kademlia: Kademlia<MemoryStore>,
    mdns: mdns::tokio::Behaviour,
    identify: identify::Behaviour,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Commands accepted by the swarm task.
#[derive(Debug)]
pub enum P2PCommand {
    /// Dial a multiaddr such as `/ip4/127.0.0.1/tcp/4001/p2p/12D3...`.
    Connect(Multiaddr),
    /// Publish an already-signed canonical record JSON to the gossip topic.
    Publish(Vec<u8>),
    /// Publish a WebRTC signaling message on the signal topic.
    PublishSignal(Vec<u8>),
    /// Trigger a Kademlia bootstrap round.
    Bootstrap,
}

/// Events emitted by the swarm task towards the HTTP/WebSocket layer.
#[derive(Debug, Clone)]
pub struct GossipEvent {
    pub source: String,
    pub data: Vec<u8>,
}

/// WebRTC signaling events emitted by the swarm task.
#[derive(Debug, Clone)]
pub struct SignalEvent {
    pub source: String,
    pub data: Vec<u8>,
}

/// Handle kept in the axum `AppState`.
pub struct P2PHandle {
    pub commands: mpsc::UnboundedSender<P2PCommand>,
    pub events: tokio::sync::Mutex<mpsc::UnboundedReceiver<GossipEvent>>,
    pub signal_events: tokio::sync::Mutex<mpsc::UnboundedReceiver<SignalEvent>>,
    pub local_peer_id: PeerId,
    pub listen_addrs: Vec<String>,
}

impl P2PHandle {
    pub fn publish_record(&self, canonical_json: Vec<u8>) {
        let _ = self.commands.send(P2PCommand::Publish(canonical_json));
    }

    pub fn publish_signal(&self, signal_data: Vec<u8>) {
        let _ = self.commands.send(P2PCommand::PublishSignal(signal_data));
    }

    pub fn connect(&self, addr: Multiaddr) {
        let _ = self.commands.send(P2PCommand::Connect(addr));
    }

    pub fn bootstrap(&self) {
        let _ = self.commands.send(P2PCommand::Bootstrap);
    }
}

/// Derive a deterministic libp2p Ed25519 identity from the node's DDN secret
/// key so that restarting the node keeps the same `PeerId`.
fn derive_libp2p_identity(secret: &[u8]) -> identity::Keypair {
    let mut hasher = Sha256::new();
    hasher.update(b"ddn-libp2p-ed25519-v1");
    hasher.update(secret);
    let seed: [u8; 32] = hasher.finalize().into();
    let sk = identity::ed25519::SecretKey::try_from_bytes(seed)
        .expect("valid ed25519 seed");
    let ed = identity::ed25519::Keypair::from(sk);
    identity::Keypair::from(ed)
}

/// Spawn the libp2p swarm on its own tokio task.
///
/// * `secret`   - the DDN Ed25519 secret key (32 bytes), used to derive a stable PeerId
/// * `tcp_port` - TCP listen port for inter-node connections
/// * `bootstrap_peers` - optional multiaddrs dialed at startup (`DDN_BOOTSTRAP_PEERS`)
pub async fn spawn_swarm(
    secret: &[u8],
    tcp_port: u16,
    bootstrap_peers: Vec<String>,
) -> Result<P2PHandle, Box<dyn std::error::Error + Send + Sync>> {
    let id_keys = derive_libp2p_identity(secret);
    let local_peer_id = PeerId::from(id_keys.public());

    let kademlia = Kademlia::new(local_peer_id, MemoryStore::new(local_peer_id));
    let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)
        .map_err(|e| e.to_string())?;

    let gs_config = gossipsub::ConfigBuilder::default()
        .validation_mode(ValidationMode::Permissive) // records are signature-verified downstream
        .build()
        .map_err(|e| format!("gossipsub config: {:?}", e))?;
    let gossipsub = gossipsub::Behaviour::new(
        MessageAuthenticity::Signed(id_keys.clone()),
        gs_config,
    )
    .map_err(|e| format!("gossipsub init: {:?}", e))?;

    let identify = identify::Behaviour::new(identify::Config::new(
        "/ddn/id/1.0.0".to_string(),
        id_keys.public(),
    ));

    let behaviour = DdnBehaviour {
        gossipsub,
        kademlia,
        mdns,
        identify,
    };

    let mut swarm = SwarmBuilder::with_existing_identity(id_keys)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|e| e.to_string())?
        .with_behaviour(|_keys| Ok(behaviour))
        .map_err(|e| e.to_string())?
        .build();

    let topic = IdentTopic::new(RECORDS_TOPIC);
    swarm
        .behaviour_mut()
        .gossipsub
        .subscribe(&topic)
        .map_err(|e| format!("subscribe: {:?}", e))?;

    let listen_addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{}", tcp_port)
        .parse()
        .map_err(|e| format!("bad listen addr: {:?}", e))?;
    Swarm::listen_on(&mut swarm, listen_addr).map_err(|e| format!("listen: {:?}", e))?;

    for bp in &bootstrap_peers {
        match bp.parse::<Multiaddr>() {
            Ok(addr) => {
                info!("bootstrapping toward {}", addr);
                if let Some(Protocol::P2p(peer)) = addr.iter().find(|p| matches!(p, Protocol::P2p(_))) {
                    swarm
                        .behaviour_mut()
                        .kademlia
                        .add_address(&peer.into(), addr.clone());
                }
                if let Err(e) = swarm.dial(addr.clone()) {
                    warn!("initial dial failed for {}: {:?}", addr, e);
                }
            }
            Err(e) => warn!("invalid bootstrap peer {:?}: {:?}", bp, e),
        }
    }

    let announced: Vec<String> = swarm
        .listeners()
        .map(|a| a.clone().with(Protocol::P2p(local_peer_id.into())).to_string())
        .collect();
    info!("libp2p peer id: {}", local_peer_id);
    for a in &announced {
        info!("libp2p listening on: {}", a);
    }

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<P2PCommand>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<GossipEvent>();
    let (sig_tx, sig_rx) = mpsc::unbounded_channel::<SignalEvent>();

    let signal_topic = IdentTopic::new(WEBRTC_SIGNAL_TOPIC);
    swarm
        .behaviour_mut()
        .gossipsub
        .subscribe(&signal_topic)
        .map_err(|e| format!("subscribe to signal topic: {:?}", e))?;

    tokio::spawn(async move {
        let mut connected: HashSet<PeerId> = HashSet::new();
        loop {
            tokio::select! {
                maybe_cmd = cmd_rx.recv() => {
                    match maybe_cmd {
                        Some(P2PCommand::Connect(addr)) => {
                            info!("dialing peer {}", addr);
                            if let Some(Protocol::P2p(peer)) = addr.iter().find(|p| matches!(p, Protocol::P2p(_))) {
                                swarm.behaviour_mut().kademlia.add_address(&peer.into(), addr.clone());
                            }
                            if let Err(e) = swarm.dial(addr.clone()) {
                                warn!("dial failed for {}: {:?}", addr, e);
                            }
                        }
                        Some(P2PCommand::Publish(data)) => {
                            match swarm.behaviour_mut().gossipsub.publish(topic.clone().hash(), data) {
                                Ok(id) => debug!("published record, msg-id {}", id),
                                Err(e) => warn!("gossipsub publish failed: {:?}", e),
                            }
                        }
                        Some(P2PCommand::PublishSignal(data)) => {
                            match swarm.behaviour_mut().gossipsub.publish(signal_topic.clone().hash(), data) {
                                Ok(id) => debug!("published webrtc signal, msg-id {}", id),
                                Err(e) => warn!("gossipsub signal publish failed: {:?}", e),
                            }
                        }
                        Some(P2PCommand::Bootstrap) => {
                            if swarm.behaviour_mut().kademlia.bootstrap().is_err() {
                                debug!("kademlia bootstrap: no known peers yet");
                            }
                        }
                        None => break,
                    }
                }
                event = swarm.select_next_some() => {
                    match event {
                        SwarmEvent::Behaviour(DdnBehaviourEvent::Gossipsub(
                            gossipsub::Event::Message { message, message_id, .. },
                        )) => {
                            debug!("gossip received ({} bytes, id {})", message.data.len(), message_id);
                            let src = message.source.map(|p| p.to_base58()).unwrap_or_else(|| "unknown".into());
                            // Route signal messages to the separate signal channel.
                            if message.topic == signal_topic.clone().hash() {
                                if sig_tx.send(SignalEvent { source: src, data: message.data }).is_err() {
                                    warn!("signal event receiver dropped");
                                }
                            } else {
                                if ev_tx.send(GossipEvent { source: src, data: message.data }).is_err() {
                                    warn!("gossip event receiver dropped");
                                }
                            }
                        }
                        SwarmEvent::Behaviour(DdnBehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                            for (peer, addr) in list {
                                info!("mDNS discovered peer {} @ {}", peer, addr);
                                swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer);
                                swarm.behaviour_mut().kademlia.add_address(&peer, addr);
                            }
                        }
                        SwarmEvent::Behaviour(DdnBehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
                            for (peer, _) in list {
                                swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer);
                            }
                        }
                        SwarmEvent::Behaviour(DdnBehaviourEvent::Identify(IdentifyEvent::Received { peer_id, info: remote, .. })) => {
                            if connected.insert(peer_id) {
                                info!("connected to peer {} (agent {})", peer_id, remote.protocol_version);
                            }
                            for addr in remote.listen_addrs {
                                swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                            }
                        }
                        SwarmEvent::Behaviour(DdnBehaviourEvent::Kademlia(KademliaEvent::OutboundQueryProgressed { result: QueryResult::Bootstrap(Ok(res)), .. })) => {
                            debug!("kademlia bootstrap finished: {} peers remaining in query", res.num_remaining);
                        }
                        SwarmEvent::NewListenAddr { address, .. } => {
                            info!("swarm listening on {}", address.with(Protocol::P2p(local_peer_id.into())));
                        }
                        SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. } => {
                            if connected.remove(&peer_id) {
                                info!("disconnected from peer {}", peer_id);
                                swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    Ok(P2PHandle {
        commands: cmd_tx,
        events: tokio::sync::Mutex::new(ev_rx),
        signal_events: tokio::sync::Mutex::new(sig_rx),
        local_peer_id,
        listen_addrs: announced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::Keypair;
    use crate::records::{BaseRecord, RecordType};
    use std::time::Duration;

    #[tokio::test]
    async fn derive_identity_is_stable() {
        let secret = Keypair::generate().secret_bytes();
        let id1 = derive_libp2p_identity(&secret);
        let id2 = derive_libp2p_identity(&secret);
        assert_eq!(id1.public(), id2.public(), "identity must be deterministic");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_node_gossip() {
        let secret_a = Keypair::generate().secret_bytes();
        let handle_a = spawn_swarm(&secret_a, 4002, vec![]).await.expect("node A swarm");

        // The listen_addrs may not be populated yet (swarm task hasn't polled).
        // Use the known TCP port to construct the bootstrap multiaddr.
        let peer_id_a = handle_a.local_peer_id;
        let bootstrap = format!("/ip4/127.0.0.1/tcp/4002/p2p/{}", peer_id_a);

        let secret_b = Keypair::generate().secret_bytes();
        let handle_b = spawn_swarm(&secret_b, 4003, vec![bootstrap]).await.expect("node B swarm");

        // Wait for nodes to discover and connect each other.
        tokio::time::sleep(Duration::from_secs(5)).await;

        let kp_a = Keypair::from_bytes(&secret_a).unwrap();
        let mut record = BaseRecord {
            id: String::new(),
            r#type: RecordType::Post,
            author: crate::crypto::pubkey_to_cid(&kp_a.public_key_bytes()),
            prev: None,
            ts: 1728900000,
            payload: serde_json::json!({ "text": "hello from node A" }),
            sig: None,
        };
        record.sign(&kp_a);
        let canonical = record.to_canonical_json().unwrap();

        handle_a.publish_record(canonical.as_bytes().to_vec());

        // Poll for the gossip event with an overall timeout.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut received = false;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut rx = match handle_b.events.try_lock() {
                Ok(guard) => guard,
                Err(_) => continue, // swarm task holds the lock, try again
            };
            if let Ok(ev) = rx.try_recv() {
                if let Ok(r) = serde_json::from_slice::<BaseRecord>(&ev.data) {
                    if r.id == record.id {
                        received = true;
                        break;
                    }
                }
            }
        }

        assert!(received, "node B did not receive the gossiped record from node A");
    }
}
