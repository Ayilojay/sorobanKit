import { useEffect, useMemo, useRef, useState } from 'react';
import freighterApi from '@stellar/freighter-api';
import toast from 'react-hot-toast';
import { Client as PaymentRouterClient, networks } from '@stellar-tags/payment-router';
import { useLatencyTracker } from '../useLatencyTracker';
import LatencyGauge from '../LatencyGauge';
import NetworkBadge from '../NetworkBadge';
import { useDebounce } from '../useDebounce';
import ScrollToTop from '../ScrollToTop';
import MobileNav from './MobileNav';
import RecentAddresses from '../components/RecentAddresses';
import { useRecentAddresses } from '../useRecentAddresses';
import { getFederation, getLookup } from '../api/client';
import {
  API_BASE,
  NAV_STORAGE_KEY,
  TOKEN_ADDRESS,
  formatShortAddress,
  formatUsername,
  resolveRecipient,
  apiErrorMessage,
  useNavState,
  useWalletMenu,
} from './shared';
import { formatAmount, parseAmount, toStroops } from '../utils/amount';
import Dialog from '../components/Dialog';

/**
 * @typedef {Object} DashboardProps
 * @property {string | null | undefined} [userPublicKey]
 * @property {() => Promise<{ ok: boolean, error?: string }>} onConnectWallet
 * @property {() => void} onDisconnectWallet
 * @property {string | number | null | undefined} [balance]
 * @property {boolean} [isRefreshing]
 * @property {string | null | undefined} [balanceError]
 * @property {() => void} onRefreshBalance
 * @property {() => void} onRegisterClick
 * @property {() => void} onAnalyticsClick
 * @property {() => void} onHistoryClick
 * @property {() => void} onHelpClick
 * @property {(state: string) => void} onRegistrationStateChange
 * @property {boolean} [canRegister]
 */

/**
 * @param {DashboardProps} props
 */
function Dashboard({
  userPublicKey,
  onConnectWallet,
  onDisconnectWallet,
  balance,
  isRefreshing,
  balanceError,
  onRefreshBalance,
  onRegisterClick,
  onAnalyticsClick,
  onHistoryClick,
  onHelpClick,
  onRegistrationStateChange,
  canRegister,
}) {
  const [isNavOpen, setIsNavOpen] = useNavState();
  const {
    menuRef,
    isOpen: isWalletMenuOpen,
    setIsOpen: setIsWalletMenuOpen,
  } = useWalletMenu();
  const closeNav = () => {
    sessionStorage.setItem(NAV_STORAGE_KEY, "false");
    setIsNavOpen(false);
  };
  const handleNav = (action) => {
    sessionStorage.setItem(NAV_STORAGE_KEY, 'false')
    setIsNavOpen(false)
    action()
  }
  const [nameTag, setNameTag] = useState('')
  const [showRecent, setShowRecent] = useState(false);
  const { recentAddresses, saveAddress, clearAddresses } = useRecentAddresses();
  /** @type {import('react').RefObject<HTMLInputElement>} */
  const recipientRef = useRef(null);
  const debouncedNameTag = useDebounce(nameTag, 300)
  const [amount, setAmount] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isReceiving, setIsReceiving] = useState(false)
  const [activeBalancePanel, setActiveBalancePanel] = useState('')
  const [showBalance, setShowBalance] = useState(true)
  const [receiveAddress, setReceiveAddress] = useState('')
  const [receiveTag, setReceiveTag] = useState('')
  const [receiveStatus, setReceiveStatus] = useState({
    text: '',
    color: '#1F2937',
    bgColor: '#F3F4F6',
  })
  const [status, setStatus] = useState({
    text: "",
    color: "#1F2937",
    bgColor: "#F3F4F6",
  });
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // Initialize latency tracker for real-time API monitoring
  const latencyTracker = useLatencyTracker(API_BASE);

  // Derived state: recompute only when the wallet key changes.
  const walletLabel = useMemo(
    () =>
      userPublicKey
        ? `Connected: ${userPublicKey.substring(0, 5)}...${userPublicKey.substring(51)}`
        : "",
    [userPublicKey],
  );

  // Derived state: formatted balance display, recomputed only when the
  // underlying balance value changes.
  const formattedBalance = useMemo(() => {
    if (balance === null || balance === undefined || balance === '') {
      return '--';
    }
    const formatted = formatAmount(balance);
    return formatted === null ? String(balance) : formatted;
  }, [balance]);

  // Derived state: whether the wallet is currently connected.
  const isWalletConnected = useMemo(() => Boolean(userPublicKey), [userPublicKey]);

  // Derived state: short display form of the connected wallet address.
  const shortWalletAddress = useMemo(
    () => (userPublicKey ? formatShortAddress(userPublicKey) : ''),
    [userPublicKey],
  );

  // Derived state: whether the recipient input is a valid, non-empty value.
  const hasValidRecipient = useMemo(
    () => nameTag.trim().length > 0,
    [nameTag],
  );

  // Derived state: parsed decimal-safe amount, recomputed only when amount changes.
  const parsedAmount = useMemo(() => parseAmount(amount), [amount]);

  // Derived state: whether the entered amount is valid for submission.
  const hasValidAmount = useMemo(
    () => parsedAmount !== null && parsedAmount > 0n,
    [parsedAmount],
  );

  // Derived state: whether the payment form can be submitted.
  const canSubmitPayment = useMemo(
    () => hasValidRecipient && hasValidAmount && !isSubmitting && !isProcessing,
    [hasValidRecipient, hasValidAmount, isSubmitting, isProcessing],
  );

  // Derived state: recent addresses list, recomputed only when it changes.
  const hasRecentAddresses = useMemo(
    () => recentAddresses.length > 0,
    [recentAddresses],
  );

  /**
   * @param {string} text
   * @param {string} color
   * @param {string} bgColor
   */
  const displayMessage = (text, color, bgColor) => {
    setStatus({ text, color, bgColor });
  };

  /**
   * @param {string} text
   * @param {string} color
   * @param {string} bgColor
   */
  const displayReceiveMessage = (text, color, bgColor) => {
    setReceiveStatus({ text, color, bgColor });
  };

  useEffect(() => {
    if (!userPublicKey) {
      Promise.resolve().then(() => onRegistrationStateChange("unknown"));
      return;
    }

    const loadReceiveDetails = async () => {
      setIsReceiving(true);
      displayReceiveMessage(
        "Loading your receive details...",
        "#1F2937",
        "#F3F4F6",
      );

      try {
        const { response, data } = await getLookup(userPublicKey);

        if (response.ok && data) {
          setReceiveAddress(data.address);
          setReceiveTag(data.username);
          displayReceiveMessage(
            "Share your username or wallet address.",
            "#059669",
            "#D1FAE5",
          );
          onRegistrationStateChange("existing");
          return;
        }

        if (response.status === 404) {
          setReceiveAddress(userPublicKey);
          setReceiveTag("");
          displayReceiveMessage(
            "No username found. Register to claim one.",
            "#D97706",
            "#FEF3C7",
          );
          // Change "new" to "skipped" to break the infinite redirect loop
          onRegistrationStateChange("skipped"); 
          return;
        }

        throw new Error(apiErrorMessage(data, `Backend error (${response.status}).`))
      } catch (error){
        setReceiveAddress(userPublicKey)
        setReceiveTag('')
        displayReceiveMessage(
          error instanceof Error ? error.message : 'Unable to load receive details.',
          '#DC2626',
          '#FEE2E2',
        )
        onRegistrationStateChange('unknown')
      } finally {
        setIsReceiving(false);
      }
    };

    loadReceiveDetails();
  }, [userPublicKey, onRegistrationStateChange]);

  useEffect(() => {
    recipientRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!debouncedNameTag || !userPublicKey) {
      return;
    }

    const searchRecipient = async () => {
      try {
        const resolved = await resolveRecipient(debouncedNameTag);
        if (resolved.error) {
          return;
        }

        if (resolved.address) {
          return;
        }

        if (resolved.tag) {
          const result = await getFederation(resolved.tag, 'name');
          const data = result.response.ok ? result.data : null;
          if (!data?.account_id) {
            return;
          }
        }
      } catch  {
        // Silently fail on search errors during typing
      }
    };

    searchRecipient();
  }, [debouncedNameTag, userPublicKey]);

  const handleConnect = async () => {
    const result = await onConnectWallet();
    if (!result.ok) {
      displayMessage(
        result.error || "Wallet connection failed.",
        "#DC2626",
        "#FEE2E2",
      );
      return;
    }

    displayMessage("Wallet connected.", "#059669", "#D1FAE5");
  };

  const handleLookup = () => {
    if (isSubmitting) return;

    const amountValue = parseAmount(amount);

    if (amountValue === null || amountValue <= 0n) {
      toast.error("Please enter a valid amount greater than zero.");
      return;
    }

    setIsConfirmOpen(true);
  };

  const handleConfirmPayment = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    const recipientInput = nameTag.trim();
    const amountValue = parseAmount(amount);

    if (amountValue === null || amountValue <= 0n) {
      toast.error("Please enter a valid amount greater than zero.");
      setIsSubmitting(false);
      return;
    }

    setIsProcessing(true);
    const toastId = toast.loading("Verifying recipient...");

    try {
      const resolved = await resolveRecipient(recipientInput);
      if (resolved.error)
        throw new Error(`Resolution error: ${resolved.error}`);

      let recipientAddress = resolved.address;
      if (!recipientAddress && resolved.tag) {
        const result = await getFederation(resolved.tag, 'name');
        const data = result.response.ok ? result.data : null;
        if (!data?.account_id)
          throw new Error(
            "Recipient address could not be resolved from backend.",
          );
        recipientAddress = data.account_id;
      }

      toast.loading("Simulating smart contract execution...", { id: toastId });
      const amountStroops = toStroops(amountValue);

      // Build and simulate the payment through the type-safe client generated
      // from the contract ABI (packages/types).
      const client = new PaymentRouterClient({
        ...networks.testnet,
        rpcUrl: "https://soroban-testnet.stellar.org",
      });

      let assembledTransaction;
      try {
        assembledTransaction = await client.route_payment({
          sender: userPublicKey,
          recipient: recipientAddress,
          token_address: TOKEN_ADDRESS,
          amount: amountStroops,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Simulation failed: ${message}`, { cause: err });
      }

      toast.loading("Approve the transaction in your wallet...", { id: toastId });
      let signedXdrResponse;
      try {
        signedXdrResponse = await freighterApi.signTransaction(
          assembledTransaction.toXDR(),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Wallet signing failed: ${message}`, { cause: err });
      }

      toast.success("Payment submitted.", { id: toastId });
      displayMessage("Payment submitted successfully.", "#059669", "#D1FAE5");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment failed.";
      toast.error(message, { id: toastId });
      displayMessage(message, "#DC2626", "#FEE2E2");
    } finally {
      setIsProcessing(false);
      setIsSubmitting(false);
      setIsConfirmOpen(false);
    }
  };

  return (
    <div className="dashboard">
      <MobileNav
        isOpen={isNavOpen}
        onClose={closeNav}
        onNavigate={handleNav}
        onRegisterClick={onRegisterClick}
        onAnalyticsClick={onAnalyticsClick}
        onHistoryClick={onHistoryClick}
        onHelpClick={onHelpClick}
      />
      <header className="dashboard-header">
        <NetworkBadge />
        <LatencyGauge tracker={latencyTracker} />
        <div className="wallet-menu" ref={menuRef}>
          <button
            type="button"
            className="wallet-menu-trigger"
            onClick={() => setIsWalletMenuOpen(!isWalletMenuOpen)}
          >
            {isWalletConnected ? shortWalletAddress : "Connect Wallet"}
          </button>
          {isWalletMenuOpen && (
            <div className="wallet-menu-dropdown">
              {isWalletConnected ? (
                <button type="button" onClick={onDisconnectWallet}>
                  Disconnect
                </button>
              ) : (
                <button type="button" onClick={handleConnect}>
                  Connect
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="balance-panel">
        <div className="balance-header">
          <span className="balance-label">Balance</span>
          <button
            type="button"
            onClick={() => setShowBalance((prev) => !prev)}
          >
            {showBalance ? "Hide" : "Show"}
          </button>
        </div>
        <div className="balance-value">
          {showBalance ? formattedBalance : "••••••"}
        </div>
        {balanceError && <p className="balance-error">{balanceError}</p>}
        <button
          type="button"
          onClick={onRefreshBalance}
          disabled={isRefreshing}
        >
          {isRefreshing ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      <section className="payment-form">
        <label htmlFor="recipient">Recipient</label>
        <input
          id="recipient"
          ref={recipientRef}
          value={nameTag}
          onChange={(event) => setNameTag(event.target.value)}
          onFocus={() => setShowRecent(true)}
          placeholder="username or wallet address"
        />
        {showRecent && hasRecentAddresses && (
          <RecentAddresses
            addresses={recentAddresses}
            onSelect={(address) => {
              setNameTag(address);
              saveAddress(address);
              setShowRecent(false);
            }}
            onClear={clearAddresses}
          />
        )}

        <label htmlFor="amount">Amount</label>
        <input
          id="amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          aria-describedby="amount-hint"
          aria-invalid={amount.trim().length > 0 && !hasValidAmount}
        />
        <p id="amount-hint" className="field-hint">
          Enter an amount with up to 7 decimal places.
        </p>

        <button
          type="button"
          onClick={handleLookup}
          disabled={!canSubmitPayment}
        >
          {isProcessing ? "Processing..." : "Send Payment"}
        </button>

        <Dialog
          isOpen={isConfirmOpen}
          onClose={() => setIsConfirmOpen(false)}
          title="Confirm payment"
          description="Review the details below before submitting."
          confirmLabel="Confirm and send"
          cancelLabel="Cancel"
          onConfirm={handleConfirmPayment}
          isBusy={isProcessing}
        >
          <dl className="confirm-details">
            <dt>Recipient</dt>
            <dd>{nameTag.trim()}</dd>
            <dt>Amount</dt>
            <dd>{formatAmount(amount) ?? amount}</dd>
          </dl>
        </Dialog>

        {status.text && (
          <p
            className="status-message"
            style={{ color: status.color, backgroundColor: status.bgColor }}
          >
            {status.text}
          </p>
        )}
      </section>

      <section className="receive-panel">
        <h2>Receive</h2>
        {isReceiving ? (
          <p>Loading...</p>
        ) : (
          <>
            <p>{receiveTag ? formatUsername(receiveTag) : receiveAddress}</p>
            {receiveStatus.text && (
              <p
                className="status-message"
                style={{
                  color: receiveStatus.color,
                  backgroundColor: receiveStatus.bgColor,
                }}
              >
                {receiveStatus.text}
              </p>
            )}
          </>
        )}
      </section>

      <ScrollToTop />
    </div>
  );
}

export default Dashboard;
