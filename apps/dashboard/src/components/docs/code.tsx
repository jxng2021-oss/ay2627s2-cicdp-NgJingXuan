import { CopyButton } from "@/components/ui";

export function Code({
  title,
  children,
}: {
  title?: string;
  children: string;
}) {
  const code = children.replace(/^\n/, "").replace(/\s+$/, "");
  return (
    <figure className="docs-code">
      <div className="docs-code-bar">
        <span className="caption-4 muted">{title ?? "Terminal"}</span>
        <CopyButton value={code} label={`Copy ${title ?? "command"}`} />
      </div>
      <pre className="body-6" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export function Note({
  tone = "tip",
  children,
}: {
  tone?: "tip" | "warning";
  children: React.ReactNode;
}) {
  return (
    <aside className="docs-note body-6" data-tone={tone}>
      <strong>{tone === "tip" ? "Tip" : "Careful"}</strong>
      <div>{children}</div>
    </aside>
  );
}

export function Params({
  rows,
}: {
  rows: [name: string, type: string, what: string][];
}) {
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label={`Reference: ${rows.map(([name]) => name).join(", ")}`.slice(
        0,
        120,
      )}
    >
      <table className="table docs-params">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">What it is</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, type, what]) => (
            <tr key={name}>
              <td data-label="Name">
                <code>{name}</code>
              </td>
              <td data-label="Type" className="mono">
                {type}
              </td>
              <td data-label="What it is">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
