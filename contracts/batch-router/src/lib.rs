#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Env, Vec};

/// Default maximum number of items allowed in a single batch.
pub const DEFAULT_MAX_BATCH_ITEMS: u32 = 100;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchConfig {
    pub max_batch_items: u32,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BatchError {
    EmptyBatch = 1,
    BatchTooLarge = 2,
    InvalidLimit = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    MaxBatchItems,
}

#[contract]
pub struct BatchRouter;

#[contractimpl]
impl BatchRouter {
    /// Initialize the router with a configurable maximum batch item count.
    /// If `max_batch_items` is zero, the default limit is used.
    pub fn initialize(env: Env, max_batch_items: u32) {
        let limit = if max_batch_items == 0 {
            DEFAULT_MAX_BATCH_ITEMS
        } else {
            max_batch_items
        };
        env.storage()
            .instance()
            .set(&DataKey::MaxBatchItems, &limit);
    }

    /// Read-only getter exposing the configured maximum batch item count.
    pub fn max_batch_items(env: Env) -> u32 {
        Self::load_limit(&env)
    }

    /// Route a batch of items. Rejects oversized or empty batches before any
    /// state mutation occurs.
    pub fn route_batch(env: Env, items: Vec<u32>) -> Result<u32, BatchError> {
        let limit = Self::load_limit(&env);
        let count = items.len();

        if count == 0 {
            return Err(BatchError::EmptyBatch);
        }
        if count > limit {
            return Err(BatchError::BatchTooLarge);
        }

        // Only after validation do we perform state changes.
        let mut processed: u32 = 0;
        for item in items.iter() {
            processed = processed.saturating_add(item);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxBatchItems, &limit);

        Ok(processed)
    }

    fn load_limit(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxBatchItems)
            .unwrap_or(DEFAULT_MAX_BATCH_ITEMS)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    fn setup(limit: u32) -> (Env, BatchRouterClient<'static>) {
        let env = Env::default();
        let contract_id = env.register_contract(None, BatchRouter);
        let client = BatchRouterClient::new(&env, &contract_id);
        client.initialize(&limit);
        (env, client)
    }

    #[test]
    fn exposes_configured_limit() {
        let (_env, client) = setup(5);
        assert_eq!(client.max_batch_items(), 5);
    }

    #[test]
    fn uses_default_when_zero() {
        let (_env, client) = setup(0);
        assert_eq!(client.max_batch_items(), DEFAULT_MAX_BATCH_ITEMS);
    }

    #[test]
    fn accepts_batch_at_limit() {
        let (env, client) = setup(3);
        let items = Vec::from_array(&env, [1u32, 2, 3]);
        assert_eq!(client.route_batch(&items), 6);
    }

    #[test]
    fn rejects_batch_over_limit() {
        let (env, client) = setup(3);
        let items = Vec::from_array(&env, [1u32, 2, 3, 4]);
        let result = client.try_route_batch(&items);
        assert_eq!(result, Err(Ok(BatchError::BatchTooLarge)));
    }

    #[test]
    fn rejects_empty_batch() {
        let (env, client) = setup(3);
        let items: Vec<u32> = Vec::new(&env);
        let result = client.try_route_batch(&items);
        assert_eq!(result, Err(Ok(BatchError::EmptyBatch)));
    }

    #[test]
    fn rejects_before_state_change() {
        let (env, client) = setup(2);
        let items = Vec::from_array(&env, [1u32, 2, 3]);
        let _ = client.try_route_batch(&items);
        // Limit remains unchanged after a rejected batch.
        assert_eq!(client.max_batch_items(), 2);
    }
}
