//! P2P networking module.
//!
//! Phase 1: real libp2p integration — see [`swarm`]:
//!   - Gossipsub for real-time record propagation (`ddn/records/v1` topic)
//!   - Kademlia DHT for peer routing / address discovery
//!   - mDNS for zero-config local network discovery
//!   - Identify for peer metadata exchange
//!
//! The legacy Phase 0 manual-peer HTTP sync endpoints (`/api/peers`, `/api/sync`)
//! are still available in `main.rs` as a fallback transport.

pub mod swarm;

pub use swarm::{spawn_swarm, P2PHandle, RECORDS_TOPIC};
