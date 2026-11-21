"use client";

import { Icon } from "@/components/icons";
import { useInView } from "./use-in-view";

const STEPS = [
  { label: "API key checked", detail: "shop server" },
  { label: "Policy allows it", detail: "amount 1,849 of 5,000" },
  { label: "Secret added", detail: "payment key ••••" },
  { label: "Provider answered", detail: "201 Created" },
  { label: "Audit event chained", detail: "request 7c41e9d2" },
];

export function GatewayMock() {
  const [ref, state] = useInView<HTMLDivElement>(0.3);
  return (
    <figure className="hero-visual">
      <div
        ref={ref}
        className="gateway-mock"
        data-state={state}
        role="img"
        aria-label="A request through the gateway: the API key is checked, the policy allows it, the secret is added, the provider answers 201, and the audit event is chained."
      >
        <div className="gateway-mock-head">
          <span className="gateway-mock-request body-5">
            POST /v1/proxy/payments/charges
          </span>
          <span className="pill caption-4">Your app never sees the key</span>
        </div>
        <ol className="gateway-mock-steps">
          {STEPS.map((step, i) => (
            <li
              key={step.label}
              className="gateway-mock-step"
              style={{ transitionDelay: `${150 + i * 180}ms` }}
            >
              <span
                className="gateway-mock-check"
                style={{ transitionDelay: `${300 + i * 180}ms` }}
              >
                <Icon name="check" size={14} />
              </span>
              <span className="body-5">{step.label}</span>
              <span className="mono caption-5">{step.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}
