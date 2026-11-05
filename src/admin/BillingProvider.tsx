import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { unavailableBilling } from "../billing/client";
import { BILLING_PERMISSION, type BillingClient, type BillingOverview } from "../billing/types";
import { localDate } from "../prospect";

type OverviewState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: BillingOverview };

export interface BillingContextValue {
  client: BillingClient;
  /** False while the billing routes are not deployed: nothing is requested and nothing is shown. */
  available: boolean;
  /** True only when the server reports accounts:admin:billing. Read-only is the default. */
  canAct: boolean;
  overview: OverviewState;
  /** Reload the cross-account figures after a change. */
  refresh: () => void;
  /** Opens an address inside the console without a page load. */
  go: (href: string) => void;
  today: string;
}

const standalone: BillingContextValue = {
  client: unavailableBilling,
  available: false,
  canAct: false,
  overview: { status: "unavailable" },
  refresh: () => undefined,
  go: (href) => window.location.assign(href),
  today: "",
};
export const BillingContext = createContext<BillingContextValue>(standalone);
export const useBilling = (): BillingContextValue => useContext(BillingContext);

/** Loads the permission and the cross-account records once, and again after a change. */
export function useBillingState(client: BillingClient, go: (href: string) => void): BillingContextValue {
  const [overview, setOverview] = useState<OverviewState>(
    client.available ? { status: "loading" } : { status: "unavailable" },
  );
  const [canAct, setCanAct] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!client.available) {
      setOverview({ status: "unavailable" });
      return;
    }
    let current = true;
    void Promise.all([
      client.access().then(
        (access) => access.permissions.includes(BILLING_PERMISSION),
        () => false,
      ),
      client.overview(),
    ]).then(
      ([allowed, data]) => {
        if (!current) return;
        setCanAct(allowed);
        setOverview({ status: "ready", data });
      },
      (cause: Error) => current && setOverview({ status: "error", message: cause.message }),
    );
    return () => {
      current = false;
    };
  }, [client, version]);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return useMemo<BillingContextValue>(
    () => ({
      client,
      available: client.available,
      canAct: client.available && canAct,
      overview,
      refresh,
      go,
      today: localDate(),
    }),
    [client, canAct, overview, refresh, go],
  );
}

export function BillingProvider({
  client,
  go,
  children,
}: {
  client: BillingClient;
  go: (href: string) => void;
  children: ReactNode;
}) {
  return <BillingContext.Provider value={useBillingState(client, go)}>{children}</BillingContext.Provider>;
}

/** Runs one read against the billing client for a page, with loading and error states. */
export function useBillingLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const { available } = useBilling();
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({
    data: null,
    error: "",
    loading: available,
  });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!available) return;
    let current = true;
    setState((previous) => ({ ...previous, error: "", loading: previous.data === null }));
    void load().then(
      (data) => current && setState({ data, error: "", loading: false }),
      (cause: Error) => current && setState({ data: null, error: cause.message, loading: false }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, version, ...deps]);
  return { ...state, reload: () => setVersion((value) => value + 1) };
}
