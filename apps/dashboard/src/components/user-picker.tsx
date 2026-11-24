"use client";

import Link from "next/link";
import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError, type PoolUser } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";
import { Button, Dialog, ErrorState, FormError, Loading } from "./ui";

export type PickBy = "id" | "email";

export interface PickedUser {
  by: PickBy;
  id: string;
  email: string;
}

const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function UserPicker({
  by,
  chosen,
  onAdd,
  onClose,
}: {
  by: PickBy | undefined;
  chosen: string[];
  onAdd: (users: PickedUser[]) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={by !== undefined}
      title={by === "id" ? "Add users by ID" : "Add users by email"}
      onClose={onClose}
      size="lg"
    >
      {by && (
        <PickerBody by={by} chosen={chosen} onAdd={onAdd} onClose={onClose} />
      )}
    </Dialog>
  );
}

function PickerBody({
  by,
  chosen,
  onAdd,
  onClose,
}: {
  by: PickBy;
  chosen: string[];
  onAdd: (users: PickedUser[]) => void;
  onClose: () => void;
}) {
  const { id } = useWorkspace();
  const pools = useLoad(() => api.pools(id), [id]);
  const [poolId, setPoolId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PoolUser[]>();
  const [notFound, setNotFound] = useState<string>();
  const [selected, setSelected] = useState<Map<string, PoolUser>>(new Map());
  const [failure, setFailure] = useState<unknown>();
  const poolSelectId = useId();
  const searchId = useId();
  const pool =
    pools.status === "ready"
      ? (pools.data.pools.find((p) => p.id === poolId) ?? pools.data.pools[0])
      : undefined;

  async function search(text: string, inPool: string) {
    setFailure(undefined);
    setNotFound(undefined);
    const trimmed = text.trim();
    try {
      if (by === "id" && USER_ID.test(trimmed)) {
        setResults([await api.poolUser(id, inPool, trimmed.toLowerCase())]);
        return;
      }
      const page = await api.poolUsers(id, inPool, {
        email: trimmed || undefined,
      });
      setResults(page.users);
      if (page.users.length === 0 && trimmed) setNotFound(trimmed);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setResults([]);
        setNotFound(trimmed);
      } else {
        setFailure(error);
      }
    }
  }

  useEffect(() => {
    if (pool) void search("", pool.id);
  }, [pool?.id]);

  function toggle(user: PoolUser) {
    const next = new Map(selected);
    if (next.has(user.id)) next.delete(user.id);
    else next.set(user.id, user);
    setSelected(next);
  }

  if (pools.status === "loading") return <Loading />;
  if (pools.status === "error") {
    return <ErrorState error={pools.error} onRetry={pools.reload} />;
  }
  if (!pool) {
    return (
      <>
        <p>
          There are no user pools in this workspace yet, so there is nobody to
          choose. Users appear once your app signs them up to a pool.
        </p>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Link
            className="button"
            data-variant="primary"
            href={`/workspaces/${id}/user-pools`}
          >
            Go to user pools
          </Link>
        </div>
      </>
    );
  }

  const already = (user: PoolUser) =>
    chosen.includes(`${by}:${by === "id" ? user.id : user.email}`);

  return (
    <div className="form">
      <p className="muted">
        {by === "id"
          ? "The flag matches these users by their user ID, so it keeps working if they change their email."
          : "The flag matches these users by their email address."}{" "}
        Only real users from your pools can be chosen.
      </p>
      <div className="flag-condition">
        <div className="field">
          <label htmlFor={poolSelectId}>User pool</label>
          <select
            id={poolSelectId}
            className="select"
            value={pool.id}
            onChange={(e) => {
              setPoolId(e.target.value);
              setQuery("");
              setSelected(new Map());
            }}
          >
            {pools.status === "ready" &&
              pools.data.pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.userCount} users)
                </option>
              ))}
          </select>
        </div>
        <form
          className="field"
          role="search"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void search(query, pool.id);
          }}
        >
          <label htmlFor={searchId}>
            {by === "id"
              ? "Search by email, or paste a user ID"
              : "Search by email"}
          </label>
          <div className="picker-search">
            <input
              id={searchId}
              className="input"
              type="search"
              value={query}
              placeholder={by === "id" ? "ada@ or a user ID" : "ada@"}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit">Search</Button>
          </div>
        </form>
      </div>

      <FormError error={failure} />
      {notFound !== undefined && (
        <p className="field-error" role="status">
          No user in {pool.name} matches &quot;{notFound}&quot;.
        </p>
      )}
      {results === undefined ? (
        <Loading />
      ) : results.length === 0 && notFound === undefined ? (
        <p className="muted">{pool.name} has no users yet.</p>
      ) : (
        results.length > 0 && (
          <ul className="picker-results" aria-label="Users found">
            {results.map((user) => {
              const added = already(user);
              return (
                <li key={user.id}>
                  <label data-disabled={added}>
                    <input
                      type="checkbox"
                      checked={added || selected.has(user.id)}
                      disabled={added}
                      onChange={() => toggle(user)}
                    />
                    <span>
                      <strong>{user.email}</strong>
                      <span className="muted body-6">
                        <code>{user.id}</code>
                        {added ? " · already chosen" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      )}

      <div className="form-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={selected.size === 0}
          onClick={() =>
            onAdd(
              [...selected.values()].map((user) => ({
                by,
                id: user.id,
                email: user.email,
              })),
            )
          }
        >
          {selected.size === 0
            ? "Add users"
            : `Add ${selected.size} ${selected.size === 1 ? "user" : "users"}`}
        </Button>
      </div>
    </div>
  );
}
