"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Load<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: T; error?: undefined }
  | { status: "error"; data?: undefined; error: unknown };

export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[],
): Load<T> & { reload: () => void } {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const generation = useRef(0);
  const run = useCallback(load, deps);

  const reload = useCallback(() => {
    const mine = ++generation.current;
    setState((previous) =>
      previous.status === "ready" ? previous : { status: "loading" },
    );
    run().then(
      (data) =>
        mine === generation.current && setState({ status: "ready", data }),
      (error: unknown) =>
        mine === generation.current && setState({ status: "error", error }),
    );
  }, [run]);

  useEffect(reload, [reload]);
  return { ...state, reload };
}
