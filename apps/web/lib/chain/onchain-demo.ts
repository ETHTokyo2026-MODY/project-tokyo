/**
 * Onchain Demo path helpers. Wire the top-nav "Demo" mode to these.
 * Do not import this from the simulated store or switch UI.
 */
export {
  clearSessionWallet,
  createGeneratedWallet,
  GeneratedWalletSession,
  listSavedWallets,
  persistWallet,
  readSessionWallet,
  type SavedWallet,
} from './generated-wallet';
