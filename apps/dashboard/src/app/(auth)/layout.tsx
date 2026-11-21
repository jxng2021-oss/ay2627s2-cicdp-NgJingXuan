import type { ReactNode } from "react";
import "../marketing.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="site">{children}</div>;
}
