import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container">
        <div className="site-footer-inner">
          <div className="site-footer-brand">
            <Link href="/" className="wordmark">
              secure-cloud
            </Link>
            <p className="muted body-6">
              Secrets, files and outside APIs for your apps, without the keys
              ever leaving the vault.
            </p>
          </div>
          <nav aria-label="Product" className="body-6">
            <p className="caption-3 muted">Product</p>
            <a href="/#benefits">Features</a>
            <a href="/#how-it-works">How it works</a>
            <a href="/#proof">Security</a>
          </nav>
          <nav aria-label="Help" className="body-6">
            <p className="caption-3 muted">Help</p>
            <a href="/#faq">Questions</a>
          </nav>
          <nav aria-label="Account" className="body-6">
            <p className="caption-3 muted">Account</p>
            <Link href="/sign-up">Create workspace</Link>
            <Link href="/login">Log in</Link>
            <Link href="/workspaces">Dashboard</Link>
          </nav>
        </div>
        <p className="site-footer-note caption-5">
          A student project for CI/CD: built, tested, scanned and delivered by
          its own pipeline.
        </p>
      </div>
    </footer>
  );
}
