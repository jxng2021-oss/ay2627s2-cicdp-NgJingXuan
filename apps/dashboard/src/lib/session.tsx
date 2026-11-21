"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { onSessionEnded } from "./api/client";
import { loginUrl } from "./safe-redirect";

const SignedInContext = createContext<(signedIn: boolean) => void>(
  () => undefined,
);

export function SessionGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState(false);
  const [ended, setEnded] = useState(false);

  useEffect(
    () =>
      onSessionEnded(() => {
        if (signedIn) setEnded(true);
      }),
    [signedIn],
  );

  if (ended) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <p className="wordmark">secure-cloud</p>
          <div className="section">
            <h1>Session ended</h1>
            <p className="muted">
              Your session expired or was signed out elsewhere. Log in again to
              continue where you left off.
            </p>
          </div>
          <div>
            <a
              className="button"
              data-variant="primary"
              href={loginUrl(pathname)}
            >
              Log in again
            </a>
          </div>
        </div>
      </main>
    );
  }
  return (
    <SignedInContext.Provider value={setSignedIn}>
      {children}
    </SignedInContext.Provider>
  );
}

export const useMarkSignedIn = () => useContext(SignedInContext);
