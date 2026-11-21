import type { Metadata } from "next";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { GatewayMock } from "@/components/marketing/gateway-mock";
import { Reveal } from "@/components/marketing/reveal";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteNav } from "@/components/marketing/site-nav";
import { TaglineReveal } from "@/components/marketing/tagline-reveal";

export const metadata: Metadata = {
  title: "secure-cloud: your apps call any API without holding the key",
  description:
    "A sealed vault and API gateway that adds your keys to your apps' outgoing calls, with encrypted files, user sign in, feature flags and an audit log you can check.",
  openGraph: {
    title: "Your apps call any API without ever holding the key",
    description:
      "A sealed vault and API gateway that adds the key to each outgoing call. A leaked app server leaks nothing worth stealing.",
    type: "website",
  },
};

const PROOF_LINE: { icon: IconName; text: string }[] = [
  { icon: "secrets", text: "256 bit AES on every secret and file" },
  { icon: "shield", text: "3 of 5 key holders to unseal" },
  { icon: "audit", text: "Every change in a chained audit log" },
];

const BENEFITS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "connections",
    title: "No payment keys on your servers",
    body: "Your app calls /v1/proxy with its own API key. The gateway adds the provider's key to the request, so a stolen server holds nothing you need to rotate in a panic.",
  },
  {
    icon: "shield",
    title: "Limits before the key is touched",
    body: "Each connection can allow only certain routes, a number of calls per minute and an amount per day. A refused call never reads the secret.",
  },
  {
    icon: "files",
    title: "Files nobody can read from the disk",
    body: "Every file is encrypted in 64 KiB chunks with its own key. Delete a workspace and its key is destroyed, so even old copies become noise.",
  },
  {
    icon: "audit",
    title: "A log that shows when it was edited",
    body: "Every key, secret, file and outside call is recorded with its request ID, each event chained to the one before by an HMAC.",
  },
  {
    icon: "users",
    title: "Sign in and rollouts for your own users",
    body: "User pools give your app passwords, tokens you verify with public keys and refresh tokens that work once. Feature flags turn things on for a share of users.",
  },
];

const STEPS = [
  {
    title: "Store the key once",
    body: "Save your payment provider's key as a secret. It is encrypted at once, and from then on nobody can read it back.",
  },
  {
    title: "Connect it and set limits",
    body: "Create a connection to the provider's API with a policy: only these routes, at most this many calls and this much money a day.",
  },
  {
    title: "Your app calls through",
    body: "Your app sends the request with its own API key. The gateway checks the policy, adds the provider's key and passes the answer back.",
  },
];

const PROOF = [
  { value: "900+", label: "automated tests run on every change" },
  { value: "3", label: "security scanners in CI: Gitleaks, Semgrep, Trivy" },
  { value: "3 of 5", label: "key holders needed to unseal the vault" },
  { value: "0", label: "routes that return a secret value" },
];

const FAQ = [
  {
    q: "Can anyone read a secret back after I save it?",
    a: "No. Secret values are write only: no route in the API or the dashboard returns one. The only code that decrypts a value is the gateway adding it to an outgoing call. If you forget a value, rotate it.",
  },
  {
    q: "What does my app need to change?",
    a: "Point the calls you make to the outside API at /v1/proxy/<connection>/... on the gateway and send your app's own API key. The gateway adds the provider's key and returns the provider's answer.",
  },
  {
    q: "What happens if an app's API key leaks?",
    a: "Revoke it in the dashboard and it stops working on the next request. Until then, rate limits for each key and the connection's policy cap what it can do, and every call is in the audit log.",
  },
  {
    q: "What happens when the server restarts?",
    a: "The vault starts sealed. Its master key exists only in memory, so after a restart three of five key holders must each give their share before secrets, file downloads or sign in work again.",
  },
  {
    q: "How are files stored?",
    a: "Each file is encrypted before it reaches the disk, in 64 KiB chunks with its own random key. That key is wrapped by your workspace's key in the vault, and file names are kept out of the stored data.",
  },
  {
    q: "What happens when I delete a workspace?",
    a: "Its encryption key is destroyed first, so every secret and file key in it can never be decrypted again, even from a backup copy. Then its data, connections, user pools and flags are removed.",
  },
  {
    q: "Can I see who did what?",
    a: "Yes. The audit log lists every sensitive action with its outcome, request ID and source IP. Each event carries an HMAC over the one before it, so an edited or deleted event breaks the chain.",
  },
  {
    q: "Does it cost anything?",
    a: "No. There is no billing and no card to enter. Create a workspace and every feature is available.",
  },
];

const CTA_LABEL = "Create your workspace";

export default function LandingPage() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SiteNav />
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="site-container hero-grid">
            <div className="hero-copy">
              <h1 id="hero-title" className="hero-title heading-1">
                <span>Your apps call any API</span>{" "}
                <span>without ever holding the key</span>
              </h1>
              <p className="hero-sub title-2">
                A sealed vault and API gateway for developers. Store each key
                once; the gateway adds it to your apps&apos; outgoing calls, so
                a leaked app server leaks nothing worth stealing.
              </p>
              <div className="hero-actions">
                <Link
                  href="/sign-up"
                  className="button"
                  data-variant="primary"
                  data-size="lg"
                >
                  {CTA_LABEL}
                </Link>
                <span className="muted caption-2">Free, no card needed</span>
              </div>
              <ul className="hero-proof caption-1" aria-label="At a glance">
                {PROOF_LINE.map((item) => (
                  <li key={item.text}>
                    <Icon name={item.icon} size={16} />
                    {item.text}
                  </li>
                ))}
              </ul>
            </div>
            <GatewayMock />
          </div>
        </section>

        <section className="band band-surface" aria-labelledby="problem-title">
          <div className="site-container section-stack">
            <Reveal className="section-head">
              <p className="eyebrow">The problem</p>
              <h2 id="problem-title" className="heading-2">
                Every app server holds the keys to your payment provider
              </h2>
              <p className="muted title-2">
                One leaked environment file, and the attacker holds them too.
              </p>
            </Reveal>
            <div className="compare">
              <Reveal className="compare-card" delay={0}>
                <h3 className="heading-6">Keys in every app</h3>
                <ul className="body-3">
                  <li>
                    <Icon name="close" /> Each server and laptop has a copy of
                    the live payment key
                  </li>
                  <li>
                    <Icon name="close" /> A leak means rotating the key
                    everywhere, in a hurry
                  </li>
                  <li>
                    <Icon name="close" /> Nothing stops a stolen key from
                    charging any amount
                  </li>
                </ul>
              </Reveal>
              <Reveal className="compare-card" delay={120}>
                <h3 className="heading-6">Keys in the vault</h3>
                <ul className="body-3">
                  <li>
                    <Icon name="check" /> Apps hold only their own API key,
                    which you can revoke
                  </li>
                  <li>
                    <Icon name="check" /> The gateway adds the provider&apos;s
                    key to each call and never returns it
                  </li>
                  <li>
                    <Icon name="check" /> Policies cap routes, calls and amounts
                    before the key is read
                  </li>
                </ul>
              </Reveal>
            </div>
          </div>
        </section>

        <section
          id="benefits"
          className="band"
          aria-labelledby="benefits-title"
        >
          <div className="site-container section-stack">
            <Reveal className="section-head">
              <p className="eyebrow">Features</p>
              <h2 id="benefits-title" className="heading-2">
                What changes when the keys leave your apps
              </h2>
            </Reveal>
            <ul className="benefit-grid">
              {BENEFITS.map((benefit, i) => (
                <Reveal key={benefit.title} as="li" delay={i * 80}>
                  <article className="benefit-card">
                    <span className="feature-tile" data-size="lg">
                      <Icon name={benefit.icon} size={20} />
                    </span>
                    <h3 className="title-1">{benefit.title}</h3>
                    <p className="muted body-6">{benefit.body}</p>
                  </article>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        <section className="band band-surface" aria-label="In short">
          <div className="site-container">
            <TaglineReveal
              className="heading-2"
              lines={[
                "Your keys stay in the vault.",
                "Your apps only ever hold a key",
                "you can revoke at any time.",
              ]}
            />
          </div>
        </section>

        <section id="how-it-works" className="band" aria-labelledby="how-title">
          <div className="site-container how-grid">
            <Reveal className="section-head">
              <p className="eyebrow">How it works</p>
              <h2 id="how-title" className="heading-2">
                Three steps, and the key never leaves the vault
              </h2>
              <ol className="steps">
                {STEPS.map((step, i) => (
                  <li key={step.title}>
                    <span className="step-number body-4" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="stack-2">
                      <h3 className="title-2">{step.title}</h3>
                      <p className="muted body-6">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Reveal>
            <Reveal delay={150}>
              <figure className="terminal">
                <pre
                  className="body-6"
                  tabIndex={0}
                  aria-label="An example call through a connection"
                >
                  <code>
                    <span>
                      <span className="terminal-prompt">$</span> curl -X POST \
                    </span>
                    <span>
                      {"  "}https://gateway/v1/proxy/payments/charges \
                    </span>
                    <span>
                      {"  "}-H &quot;Authorization: Bearer $APP_KEY&quot; \
                    </span>
                    <span>
                      {"  "}-d &apos;{"{"}&quot;amount&quot;: 1849{"}"}&apos;
                    </span>
                    <span className="terminal-out">
                      201 {"{"}&quot;id&quot;: &quot;ch_7f3a91&quot;,
                      &quot;status&quot;: &quot;succeeded&quot;{"}"}
                    </span>
                    <span className="terminal-note">
                      # the payment key was added by the gateway
                    </span>
                  </code>
                </pre>
                <figcaption className="muted caption-2">
                  Your app only ever sends its own API key, which you can
                  revoke.
                </figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        <section
          id="proof"
          className="band band-surface"
          aria-labelledby="proof-title"
        >
          <div className="site-container section-stack">
            <Reveal className="section-head">
              <p className="eyebrow">Security you can check</p>
              <h2 id="proof-title" className="heading-2">
                Built, tested and scanned by its own pipeline
              </h2>
              <p className="muted title-2">
                Every change runs the full test suite and three security
                scanners before it can merge.
              </p>
            </Reveal>
            <dl className="proof-grid">
              {PROOF.map((item, i) => (
                <Reveal key={item.label} delay={i * 80} className="proof-item">
                  <dt className="muted body-6">{item.label}</dt>
                  <dd className="heading-3">{item.value}</dd>
                </Reveal>
              ))}
            </dl>
          </div>
        </section>

        <section id="faq" className="band" aria-labelledby="faq-title">
          <div className="site-container section-stack">
            <Reveal className="section-head section-head-center">
              <p className="eyebrow">Questions</p>
              <h2 id="faq-title" className="heading-2">
                What people ask before they move their keys
              </h2>
            </Reveal>
            <div className="faq">
              {FAQ.map((item) => (
                <details key={item.q}>
                  <summary className="title-3">
                    {item.q}
                    <Icon name="plus" size={20} />
                  </summary>
                  <p className="body-3">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="band" aria-labelledby="cta-title">
          <div className="site-container">
            <Reveal>
              <div className="cta-card">
                <h2 id="cta-title" className="heading-2">
                  Stop handing payment keys to your apps
                </h2>
                <p className="muted title-2">
                  Free, no card needed. Your workspace is ready as soon as you
                  sign up.
                </p>
                <Link
                  href="/sign-up"
                  className="button"
                  data-variant="primary"
                  data-size="lg"
                >
                  {CTA_LABEL}
                </Link>
              </div>
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
