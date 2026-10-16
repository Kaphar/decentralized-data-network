//! P2P networking module - skeleton for Phase 1 libp2p integration.
//! Phase 0 uses manual peer configuration via HTTP API (see main.rs /api/peers and /api/sync).
//!
//! Planned Phase 1 features:
//!   - libp2p Kademlia DHT for peer discovery
//!   - Gossipsub for real-time record propagation
//!   - mDNS for local network discovery
//!   - Identify protocol for peer metadata exchange

use libp2p::PeerId;

pub struct P2PManager {
    pub peer_id: PeerId,
}

impl P2PManager {
    pub fn new(peer_id: PeerId) -> Self {
        P2PManager { peer_id }
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }
}