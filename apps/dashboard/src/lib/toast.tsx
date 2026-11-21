"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const ToastContext = createContext<(message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | undefined>();
  const show = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(
      () => setMessage((current) => (current === text ? undefined : current)),
      4000,
    );
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="status-region" role="status" aria-live="polite">
        {message && <div className="toast">{message}</div>}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
