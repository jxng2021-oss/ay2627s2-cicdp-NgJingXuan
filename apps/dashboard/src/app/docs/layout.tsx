import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/docs-nav";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteNav } from "@/components/marketing/site-nav";
import "../marketing.css";
import "../docs.css";

export const metadata: Metadata = {
  title: {
    template: "%s · secure-cloud SDK docs",
    default: "secure-cloud SDK docs",
  },
  description:
    "How to use the secure-cloud SDK in a Node.js or Express app: call outside APIs without holding their keys, store encrypted files and sign your users in.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <a href="#docs-content" className="skip-link">
        Skip to content
      </a>
      <SiteNav />
      <div className="site-container docs-shell">
        <DocsNav />
        <main id="docs-content" className="docs-content">
          {children}
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
