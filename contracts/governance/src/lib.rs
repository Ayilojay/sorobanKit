//! Governance contract with a version/interface handshake for candidate
//! governance contracts. Before a timelocked authority change is applied, the
//! candidate contract's identity and interface version are validated so that
//! incompatible implementations are rejected.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

/// Interface version this governance contract expects from a candidate.
pub const INTERFACE_VERSION: u32 = 1;

/// Storage keys used by the governance contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    PendingAdminUnlock,
}

/// Identity reported by a candidate governance contract via its handshake.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceIdentity {
    /// Human-readable contract name, e.g. `governance`.
    pub name: Symbol,
    /// Interface version the candidate implements.
    pub interface_version: u32,
}

/// Client used to call the handshake on a candidate governance contract.
#[soroban_sdk::contractclient(name = "GovernanceHandshakeClient")]
pub trait GovernanceHandshake {
    /// Returns the candidate's identity (name + interface version).
    fn identity(env: Env) -> GovernanceIdentity;
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the governance contract with an admin authority.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Expose this contract's identity for deployment preflight checks.
    pub fn identity(env: Env) -> GovernanceIdentity {
        GovernanceIdentity {
            name: Symbol::new(&env, "governance"),
            interface_version: INTERFACE_VERSION,
        }
    }

    /// Returns the currently active admin authority.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Validate a candidate governance contract's identity and interface
    /// version. Panics (rejects) when the candidate is incompatible.
    pub fn validate_candidate(env: Env, candidate: Address) {
        let identity = GovernanceHandshakeClient::new(&env, &candidate).identity();
        Self::assert_compatible(&identity);
    }

    /// Propose a new admin authority. The candidate's handshake is validated
    /// before the proposal is recorded, and again before it is applied.
    pub fn propose_admin(env: Env, candidate: Address, unlock_ledger: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        Self::validate_candidate(env.clone(), candidate.clone());

        env.storage().instance().set(&DataKey::PendingAdmin, &candidate);
        env.storage()
            .instance()
            .set(&DataKey::PendingAdminUnlock, &unlock_ledger);
    }

    /// Apply a previously proposed admin change once the timelock has elapsed.
    /// Re-validates the candidate handshake to guard against interface drift.
    pub fn apply_admin_change(env: Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        let candidate: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .expect("no pending admin");
        let unlock_ledger: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdminUnlock)
            .expect("no pending admin");

        if env.ledger().sequence() < unlock_ledger {
            panic!("timelock not elapsed");
        }

        // Re-verify the candidate before committing the authority change.
        Self::validate_candidate(env.clone(), candidate.clone());

        env.storage().instance().set(&DataKey::Admin, &candidate);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage().instance().remove(&DataKey::PendingAdminUnlock);
    }

    /// Cancel a pending admin change.
    pub fn cancel_admin_change(env: Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage().instance().remove(&DataKey::PendingAdminUnlock);
    }

    /// Returns the pending admin candidate, if any.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    fn assert_compatible(identity: &GovernanceIdentity) {
        if identity.name != Symbol::new(&identity.name.env(), "governance") {
            panic!("incompatible governance contract name");
        }
        if identity.interface_version != INTERFACE_VERSION {
            panic!("incompatible governance interface version");
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{contract, contractimpl, Env};

    #[contract]
    pub struct CompatibleCandidate;

    #[contractimpl]
    impl CompatibleCandidate {
        pub fn identity(env: Env) -> GovernanceIdentity {
            GovernanceIdentity {
                name: Symbol::new(&env, "governance"),
                interface_version: INTERFACE_VERSION,
            }
        }
    }

    #[contract]
    pub struct WrongVersionCandidate;

    #[contractimpl]
    impl WrongVersionCandidate {
        pub fn identity(env: Env) -> GovernanceIdentity {
            GovernanceIdentity {
                name: Symbol::new(&env, "governance"),
                interface_version: INTERFACE_VERSION + 1,
            }
        }
    }

    #[contract]
    pub struct WrongNameCandidate;

    #[contractimpl]
    impl WrongNameCandidate {
        pub fn identity(env: Env) -> GovernanceIdentity {
            GovernanceIdentity {
                name: Symbol::new(&env, "not_governance"),
                interface_version: INTERFACE_VERSION,
            }
        }
    }

    fn setup() -> (Env, GovernanceContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, GovernanceContract);
        let client = GovernanceContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    #[test]
    fn identity_reports_expected_interface() {
        let (env, client, _admin) = setup();
        let identity = client.identity();
        assert_eq!(identity.name, Symbol::new(&env, "governance"));
        assert_eq!(identity.interface_version, INTERFACE_VERSION);
    }

    #[test]
    fn propose_and_apply_compatible_candidate() {
        let (env, client, _admin) = setup();
        let candidate = env.register_contract(None, CompatibleCandidate);
        let unlock = env.ledger().sequence() + 10;

        client.propose_admin(&candidate, &unlock);
        assert_eq!(client.pending_admin(), Some(candidate.clone()));

        env.ledger().set_sequence_number(unlock);
        client.apply_admin_change();
        assert_eq!(client.admin(), candidate);
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn apply_before_timelock_panics() {
        let (env, client, _admin) = setup();
        let candidate = env.register_contract(None, CompatibleCandidate);
        let unlock = env.ledger().sequence() + 10;
        client.propose_admin(&candidate, &unlock);
        client.apply_admin_change();
    }

    #[test]
    #[should_panic(expected = "incompatible governance interface version")]
    fn propose_rejects_wrong_version() {
        let (env, client, _admin) = setup();
        let candidate = env.register_contract(None, WrongVersionCandidate);
        let unlock = env.ledger().sequence() + 10;
        client.propose_admin(&candidate, &unlock);
    }

    #[test]
    #[should_panic(expected = "incompatible governance contract name")]
    fn propose_rejects_wrong_name() {
        let (env, client, _admin) = setup();
        let candidate = env.register_contract(None, WrongNameCandidate);
        let unlock = env.ledger().sequence() + 10;
        client.propose_admin(&candidate, &unlock);
    }

    #[test]
    fn cancel_clears_pending_admin() {
        let (env, client, _admin) = setup();
        let candidate = env.register_contract(None, CompatibleCandidate);
        let unlock = env.ledger().sequence() + 10;
        client.propose_admin(&candidate, &unlock);
        client.cancel_admin_change();
        assert_eq!(client.pending_admin(), None);
    }
}
