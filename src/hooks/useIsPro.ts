import { useAudioStore } from '../store/useAudioStore';

/**
 * Whether the one-time upgrade is owned.
 *
 * Every app in the portfolio keeps entitlement in its own domain store under its own name, so
 * the shared ad components read it through this adapter instead. It is the only file of the
 * ads integration that differs between apps.
 */
export const useIsPro = (): boolean => useAudioStore((state) => state.isPro);
