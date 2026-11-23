import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiErrorMessage, walletKit } from './shared'; // <-- 1. Import walletKit instead of Freighter
import { getLookup } from '../api/client';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PartialDataNotice,
} from '../components/states';

const USERNAME_REGEX = /^[a-zA-Z0-9]/;

const DRAFT_STORAGE_KEY = 'stellar-pay:registration-draft';
const DRAFT_SCHEMA_VERSION = 1;
const DRAFT_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Resolve the active Stellar network identifier used to bind drafts.
 * @returns {string}
 */
function resolveNetwork() {
  const env = /** @type {any} */ (import.meta)?.env || {};
  return env.VITE_STELLAR_NETWORK || env.VITE_NETWORK || 'testnet';
}

/**
 * @typedef {Object} RegistrationDraft
 * @property {number} version
 * @property {string} account
 * @property {string} network
 * @property {string} username
 * @property {string} memoType
 * @property {string} memo
 * @property {number} savedAt
 */

/**
 * Read a persisted draft, discarding anything that is malformed, expired,
 * or bound to a different account/network. Never stores secrets.
 * @param {string} account
 * @param {string} network
 * @returns {RegistrationDraft | null}
 */
function readDraft(account, network) {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  let raw;
  try {
    raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearDraft();
    return null;
  }

  const isValidShape =
    parsed &&
    typeof parsed === 'object' &&
    parsed.version === DRAFT_SCHEMA_VERSION &&
    typeof parsed.account === 'string' &&
    typeof parsed.network === 'string' &&
    typeof parsed.username === 'string' &&
    typeof parsed.memoType === 'string' &&
    typeof parsed.memo === 'string' &&
    typeof parsed.savedAt === 'number';

  if (!isValidShape) {
    clearDraft();
    return null;
  }

  const expired = Date.now() - parsed.savedAt > DRAFT_TTL_MS;
  const incompatible = parsed.account !== account || parsed.network !== network;

  if (expired || incompatible) {
    clearDraft();
    return null;
  }

  return /** @type {RegistrationDraft} */ (parsed);
}

/**
 * Persist only non-secret draft fields.
 * @param {RegistrationDraft} draft
 */
function writeDraft(draft) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage may be unavailable (private mode, quota). Drafts are best-effort.
  }
}

function clearDraft() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * @typedef {Object} RegistrationPageProps
 * @property {string} userPublicKey
 * @property {(publicKey: string) => void} setUserPublicKey
 * @property {() => void} onBack
 * @property {() => void} onRegistered
 */

/**
 * @typedef {Object} Status
 * @property {string} text
 * @property {string} tone
 */

/**
 * @param {RegistrationPageProps} props
 */
function RegistrationPage({
  userPublicKey,
  setUserPublicKey,
  onBack,
  onRegistered,
}) {
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [addressError, setAddressError] = useState("");
  const [memoType, setMemoType] = useState("");
  const [memo, setMemo] = useState("");
  const [memoError, setMemoError] = useState("");
  /** @type {[Status, (status: Status) => void]} */
  const [status, setStatus] = useState({
    text: "Connect a wallet to begin your registration.",
    tone: "neutral",
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingExisting, setIsCheckingExisting] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [draftNotice, setDraftNotice] = useState("");
  const [hasDraft, setHasDraft] = useState(false);

  const network = useMemo(() => resolveNetwork(), []);
  const draftRestoredRef = useRef(false);

  const walletLabel = userPublicKey
    ? `Connected: ${userPublicKey.substring(0, 5)}...${userPublicKey.substring(51)}`
    : "No wallet connected";

  /**
   * @param {string} text
   * @param {string} [tone]
   */
  const setStatusMessage = (text, tone = "neutral") => {
    setStatus({ text, tone });
  };

  // Restore a compatible draft when the account/network becomes available.
  useEffect(() => {
    if (!userPublicKey) {
      setHasDraft(false);
      return;
    }

    const draft = readDraft(userPublicKey, network);
    if (!draft) {
      setHasDraft(false);
      return;
    }

    setUsername(draft.username);
    setMemoType(draft.memoType);
    setMemo(draft.memo);
    setHasDraft(true);
    setDraftNotice("Restored your saved registration draft.");
    draftRestoredRef.current = true;
  }, [userPublicKey, network]);

  // Persist non-secret draft fields as the user edits.
  useEffect(() => {
    if (!userPublicKey) return;
    if (!username && !memoType && !memo) {
      clearDraft();
      setHasDraft(false);
      return;
    }

    writeDraft({
      version: DRAFT_SCHEMA_VERSION,
      account: userPublicKey,
      network,
      username,
      memoType,
      memo,
      savedAt: Date.now(),
    });
    setHasDraft(true);
  }, [userPublicKey, network, username, memoType, memo]);

  const handleClearDraft = useCallback(() => {
    clearDraft();
    setHasDraft(false);
    setDraftNotice("Draft cleared.");
    setUsername("");
    setMemoType("");
    setMemo("");
    setUsernameError("");
    setMemoError("");
  }, []);

  const checkExisting = useCallback(async () => {
    if (!userPublicKey) return;
    setIsCheckingExisting(true);
    setLookupError("");
    try {
      const { response, data } = await getLookup(userPublicKey);

      if (response.ok && data?.username) {
        onRegistered();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLookupError(message || "Unable to check existing registration.");
    } finally {
      setIsCheckingExisting(false);
    }
  }, [userPublicKey, onRegistered]);

  useEffect(() => {
    if (!userPublicKey) {
      return;
    }
    checkExisting();
  }, [userPublicKey, checkExisting]);

  // 2. Updated to use the universal walletKit modal instead of Freighter specifically
  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      await walletKit.openModal({
        onWalletSelected: async (option) => {
          walletKit.setWallet(option.id);
          const addressResponse = await walletKit.getAddress();

          const publicKey = typeof addressResponse === 'string'
            ? addressResponse
            : addressResponse.address;

          setUserPublicKey(publicKey);
          setStatusMessage(`Wallet connected. Pick your username.`, "success");
        }
      });
    } catch {
      setStatusMessage("Wallet connection cancelled or failed.", "error");
    } finally {
      setIsConnecting(false);
    }
  };

  /**
   * @param {import('react').FormEvent<HTMLFormElement>} event
   */
  const handleSubmit = async (event) => {
    if (isSubmitting) return;

    event.preventDefault();
    const cleaned = username.trim();

    if (!userPublicKey) {
      setStatusMessage("Connect a wallet before registering.", "error");
      return;
    }

    if (cleaned.length < 3) {
      setStatusMessage("Username must be at least 3 characters.", "error");
      return;
    }

    if (!USERNAME_REGEX.test(cleaned)) {
      setStatusMessage(
        "Username may only contain letters, numbers, hyphens, and underscores.",
        "error",
      );
      return;
    }

    // Validate memo fields before signing
    if (memoType && !memo) {
      setMemoError("Memo value is required when a memo type is selected.");
      return;
    }
    if (!memoType && memo) {
      setMemoError("Please select a memo type.");
      return;
    }
    if (memoType === "text" && memo.length > 28) {
      setMemoError("Text memo must not exceed 28 characters.");
      return;
    }
    setMemoError("");

    setIsSubmitting(true);
    // 3. Removed the hardcoded Freighter text
    setStatusMessage(
      "Approve the signature request in your wallet...",
      "neutral",
    );

    /** @type {string | undefined} */
    let signature;
    /** @type {string | undefined} */
    let signerAddress;
    try {
      const message = `register:${cleaned.toLowerCase()}:${userPublicKey}`;

      // 4. Use walletKit to sign the data dynamically based on the selected wallet
      // Note: Some wallet kit versions wrap this differently. If signBlob is unavailable,
      // check your specific @creit.tech/stellar-wallets-kit version docs for message signing.
      const result = walletKit.signBlob
        ? await walletKit.signBlob(message)
        : await walletKit.signMessage(message, { address: userPublicKey });

      if (result && result.error) throw new Error(result.error);

      let rawSignature = typeof result === 'string' ? result : (result.signedMessage || result.signature);

      // walletKit might return a Uint8Array or Buffer object. Convert to base64 string.
      if (typeof rawSignature === 'object' && rawSignature !== null) {
        /** @type {Uint8Array} */
        let uint8;
        if (rawSignature.type === 'Buffer' && Array.isArray(rawSignature.data)) {
          uint8 = new Uint8Array(rawSignature.data);
        } else if (rawSignature instanceof Uint8Array) {
          uint8 = rawSignature;
        } else if (rawSignature.buffer instanceof ArrayBuffer) {
          uint8 = new Uint8Array(rawSignature.buffer);
        } else {
          uint8 = new Uint8Array(Object.values(rawSignature));
        }
        let binary = '';
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        // If the walletKit accidentally returned the ASCII bytes of the base64 string,
        // 'binary' will just be the base64 string itself. We shouldn't double-encode it.
        if (binary.length >= 80 && binary.length <= 90 && /^[a-zA-Z0-9+/]+={0,2}$/.test(binary)) {
          signature = binary;
        } else {
          signature = btoa(binary);
        }
      } else {
        signature = rawSignature;
      }

      if (!signature) {
        throw new Error("Failed to capture signature from wallet.");
      }

      signerAddress = userPublicKey;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Check if it's the specific LOBSTR unsupported error
      if (message.includes("signMessage")) {
        setStatusMessage(
          "LOBSTR does not support registration signatures. Please click 'Back to dashboard' to skip this step, or connect with Freighter.",
          "error"
        );
      } else {
        // Handle all other normal errors
        setStatusMessage(message || "Signature request cancelled.", "error");
      }
      setIsSubmitting(false);
      return;
    }

    setStatusMessage("Submitting your registration...", "neutral");

    try {
      fetch(`${API_BASE}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: cleaned.toLowerCase(),
          address: userPublicKey,
          signature,
          signerAddress,
          ...(memoType && memo && { memo_type: memoType, memo }),
        }),
      })
        .then(async (response) => {
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            if (response.status === 422) {
              const fieldErrors = { username: "", address: "" };
              const errors = Array.isArray(data?.errors) ? data.errors : [];
              errors.forEach((entry) => {
                const field = entry?.field || entry?.param;
                const message = entry?.message || entry?.msg || "Invalid value.";
                if (field === "username" || field === "address") {
                  fieldErrors[field] = fieldErrors[field]
                    ? `${fieldErrors[field]} ${message}`
                    : message;
                }
              });
              if (fieldErrors.username || fieldErrors.address) {
                setUsernameError(fieldErrors.username);
                setAddressError(fieldErrors.address);
                setStatusMessage("", "neutral");
                return null;
              }
            }

            if (response.status === 409) {
              setUsernameError("Username already taken");
              setStatusMessage("", "neutral");
              return null;
            }

            throw new Error(
              apiErrorMessage(data, "Registration failed."),
            );
          }
          return data;
        })
        .then((data) => {
          if (data === null) {
            return;
          }
          setStatusMessage("Username reserved and saved.", "success");
          clearDraft();
          setHasDraft(false);

          setTimeout(() => {
            if (typeof onRegistered === 'function') {
              onRegistered();
            }
          }, 1500);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setStatusMessage(message || "Registration failed.", "error");
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(message || "Registration failed.", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="registration">
      <section className="hero-panel">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <p className="brand-eyebrow">Stellar Pay</p>
            <h1>Claim your on-chain identity.</h1>
          </div>
        </div>
        <p className="hero-copy">
          Register a username that follows your wallet across apps, tips, and
          payments. Your identity is secured by your Stellar keypair.
        </p>
        <div className="wallet-card">
          <div>
            <p className="wallet-label">Wallet</p>
            <p className="wallet-value">{walletLabel}</p>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={handleConnect}
            disabled={isConnecting}
          >
            {isConnecting ? "Connecting..." : userPublicKey ? "Reconnect" : "Connect Wallet"}
          </button>
        </div>
      </section>

      <section className="form-panel">
        {isCheckingExisting && (
          <LoadingState label="Checking for an existing registration..." />
        )}

        {lookupError && !isCheckingExisting && (
          <ErrorState
            title="Could not check existing registration"
            description={lookupError}
            onRetry={checkExisting}
          />
        )}

        {!isCheckingExisting && !lookupError && !userPublicKey && (
          <EmptyState
            title="No wallet connected"
            description="Connect a wallet to start your registration."
          />
        )}

        {draftNotice && (
          <PartialDataNotice
            message={draftNotice}
            onDismiss={() => setDraftNotice("")}
          />
        )}

        {hasDraft && (
          <div className="draft-controls">
            <span className="draft-hint">
              Draft saved locally for this account and network. Expires after 24 hours.
            </span>
            <button
              type="button"
              className="link-button"
              onClick={handleClearDraft}
            >
              Clear draft
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                if (usernameError) setUsernameError("");
              }}
              placeholder="stellar-fan"
              autoComplete="off"
            />
            {usernameError && <small className="field-error">{usernameError}</small>}
          </label>

          <label className="field">
            <span>Address</span>
            <input
              type="text"
              value={userPublicKey || ""}
              readOnly
              placeholder="Connect a wallet"
            />
            {addressError && <small className="field-error">{addressError}</small>}
          </label>

          <label className="field">
            <span>Memo type (optional)</span>
            <select
              value={memoType}
              onChange={(event) => {
                setMemoType(event.target.value);
                if (memoError) setMemoError("");
              }}
            >
              <option value="">None</option>
              <option value="text">Text</option>
              <option value="id">ID</option>
            </select>
          </label>

          {memoType && (
            <label className="field">
              <span>Memo value</span>
              <input
                type="text"
                value={memo}
                onChange={(event) => {
                  setMemo(event.target.value);
                  if (memoError) setMemoError("");
                }}
                placeholder={memoType === "text" ? "Up to 28 characters" : "Numeric ID"}
              />
              {memoError && <small className="field-error">{memoError}</small>}
            </label>
          )}

          <button
            type="submit"
            className="primary-button"
            disabled={isSubmitting}
            aria-busy={isSubmitting ? "true" : "false"}
          >
            {isSubmitting ? "Registering..." : "Register username"}
          </button>

          {status.text && (
            <p className={`status status-${status.tone}`}>{status.text}</p>
          )}

          <button type="button" className="link-button" onClick={onBack}>
            Back to dashboard
          </button>
        </form>
      </section>
    </div>
  );
}

export default RegistrationPage;