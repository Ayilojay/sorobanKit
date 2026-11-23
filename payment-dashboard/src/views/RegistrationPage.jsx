import { useEffect, useRef, useState } from 'react';
import { API_BASE, apiErrorMessage, walletKit } from './shared'; // <-- 1. Import walletKit instead of Freighter
import { getLookup } from '../api/client';
import { useConnectivity } from '../hooks/useConnectivity';

const USERNAME_REGEX = /^[a-zA-Z0-9]/;

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
  const { isOffline } = useConnectivity();

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

  /**
   * Announce async success/failure through the shared live region.
   * @param {string} text
   * @param {"success" | "error"} tone
   */
  const announceStatus = (text, tone) => {
    setStatusMessage(text, tone);
    announce(text, { politeness: tone === "error" ? "assertive" : "polite" });
  };

  /**
   * Resolve a server error payload into actionable, accessible guidance.
   * @param {unknown} data
   * @param {string} [fallback]
   */
  const resolveApiError = (data, fallback = "Registration failed.") => {
    const code =
      data && typeof data === "object" && "code" in data
        ? /** @type {{ code?: unknown }} */ (data).code
        : undefined;
    const guidance = getApiErrorGuidance(
      typeof code === "string" ? code : undefined,
    );
    if (guidance) {
      return guidance;
    }
    return { message: apiErrorMessage(data, fallback), retryable: false };
  };

  useEffect(() => {
    if (!userPublicKey) {
      return;
    }

    const checkExisting = async () => {
      try {
        const { response, data } = await getLookup(userPublicKey);

        if (response.ok && data?.username) {
          onRegistered();
        }
      } catch {
        // Ignore lookup errors in registration view.
      }
    };

    checkExisting();
  }, [userPublicKey, onRegistered]);

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
      announceStatus("Wallet connection cancelled or failed.", "error");
    } finally {
      setIsConnecting(false);
    }
  };

  /**
   * Validates the form and, when valid, opens the confirmation dialog.
   * @param {import('react').FormEvent<HTMLFormElement>} event
   */
  const handleSubmit = (event) => {
    if (isSubmitting) return;

    event.preventDefault();
    const cleaned = username.trim();

    if (!userPublicKey) {
      announceStatus("Connect a wallet before registering.", "error");
      return;
    }

    if (cleaned.length < 3) {
      announceStatus("Username must be at least 3 characters.", "error");
      return;
    }

    if (!USERNAME_REGEX.test(cleaned)) {
      announceStatus(
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

    setIsConfirmOpen(true);
  };

  /**
   * Performs the actual registration after the user confirms in the dialog.
   */
  const handleConfirmRegistration = async () => {
    if (isSubmitting) return;

    const cleaned = username.trim();
    setIsConfirmOpen(false);
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
        announceStatus(
          "LOBSTR does not support registration signatures. Please click 'Back to dashboard' to skip this step, or connect with Freighter.",
          "error"
        );
      } else {
        // Handle all other normal errors
        announceStatus(message || "Signature request cancelled.", "error");
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

            const guidance = resolveApiError(data, "Registration failed.");
            throw new Error(guidance.message);
          }
          return data;
        })
        .then((data) => {
          if (data === null) {
            return;
          }
          announceStatus("Username reserved and saved.", "success");

          setTimeout(() => {
            if (typeof onRegistered === 'function') {
              onRegistered();
            }
          }, 1500);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          announceStatus(message || "Registration failed.", "error");
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      announceStatus(message || "Registration failed.", "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="registration" data-testid="registration-page">
      <section className="hero-panel" data-testid="registration-hero">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <p className="brand-eyebrow">Stellar Pay</p>
            <h1 ref={headingRef} tabIndex={-1}>
              Claim your on-chain identity.
            </h1>
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
            aria-label={
              userPublicKey
                ? "Reconnect wallet"
                : "Connect a Stellar wallet to begin registration"
            }
            aria-busy={isConnecting ? "true" : "false"}
          >
            {isConnecting ? "Connecting..." : userPublicKey ? "Reconnect" : "Connect Wallet"}
          </button>
        </div>
      </section>

      <section className="form-panel" data-testid="registration-form-panel">
        <form onSubmit={handleSubmit} data-testid="registration-form">
          <label className="field">
            <span>Username</span>
            <input
              id="registration-username"
              type="text"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                if (usernameError) setUsernameError("");
              }}
              placeholder="stellar-fan"
              autoComplete="off"
              aria-required="true"
              aria-invalid={usernameError ? "true" : "false"}
              aria-describedby={usernameError ? "registration-username-error" : undefined}
            />
            {usernameError && (
              <small id="registration-username-error" className="field-error" role="alert">
                {usernameError}
              </small>
            )}
          </label>

          <label className="field" htmlFor="registration-address">
            <span>Address</span>
            <input
              id="registration-address"
              type="text"
              value={userPublicKey || ""}
              readOnly
              placeholder="Connect a wallet"
              aria-invalid={addressError ? "true" : "false"}
              aria-describedby={addressError ? "registration-address-error" : undefined}
            />
            {addressError && (
              <small id="registration-address-error" className="field-error" role="alert">
                {addressError}
              </small>
            )}
          </label>

          <label className="field" htmlFor="registration-memo-type">
            <span>Memo type (optional)</span>
            <select
              id="registration-memo-type"
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
            <label className="field" htmlFor="registration-memo-value">
              <span>Memo value</span>
              <input
                id="registration-memo-value"
                type="text"
                value={memo}
                onChange={(event) => {
                  setMemo(event.target.value);
                  if (memoError) setMemoError("");
                }}
                placeholder={memoType === "text" ? "Up to 28 characters" : "Numeric ID"}
                aria-invalid={memoError ? "true" : "false"}
                aria-describedby={memoError ? "registration-memo-error" : undefined}
              />
              {memoError && (
                <small id="registration-memo-error" className="field-error" role="alert">
                  {memoError}
                </small>
              )}
            </label>
          )}

          <button
            ref={confirmTriggerRef}
            type="submit"
            className="primary-button"
            disabled={isSubmitting || isOffline}
            aria-busy={isSubmitting ? "true" : "false"}
            aria-describedby={isOffline ? "registration-offline-note" : undefined}
            data-testid="registration-submit"
          >
            {isSubmitting ? "Registering..." : "Register username"}
          </button>

          {isOffline && (
            <p
              id="registration-offline-note"
              className="status status-neutral"
              role="note"
              data-testid="registration-offline-note"
            >
              You are offline. Registration is read-only until your connection
              is restored.
            </p>
          )}

          {status.text && (
            <p
              className={`status status-${status.tone}`}
              role="status"
              aria-live="polite"
              data-testid="registration-status"
            >
              {status.text}
            </p>
          )}

          <button
            type="button"
            className="link-button"
            onClick={onBack}
            data-testid="registration-back"
          >
            Back to dashboard
          </button>
        </form>
      </section>

      <Dialog
        open={isConfirmOpen}
        title="Confirm registration"
        description={`Register the username "${username.trim().toLowerCase()}" for this wallet? You will be asked to sign a message in your wallet.`}
        onClose={() => setIsConfirmOpen(false)}
        returnFocusRef={confirmTriggerRef}
        confirmLabel="Confirm and sign"
        cancelLabel="Cancel"
        onConfirm={handleConfirmRegistration}
        isBusy={isSubmitting}
      />
    </div>
  );
}

export default RegistrationPage;