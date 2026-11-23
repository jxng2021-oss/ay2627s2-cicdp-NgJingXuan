"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  ArrowLink,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Pager,
  ShortValue,
  formatDate,
} from "@/components/ui";
import { PoolRoles } from "@/components/pool-roles";
import { PoolUserStatus } from "@/components/pool-user-status";
import { ApiError } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

export default function UserPoolPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const { id, isOwner } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const pool = useLoad(() => api.pool(id, poolId), [id, poolId]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<{ cursor?: string; email?: string }>({});
  const users = useLoad(
    () => api.poolUsers(id, poolId, query),
    [id, poolId, query],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [deletingPool, setDeletingPool] = useState(false);

  if (pool.status === "loading") return <Loading />;
  if (pool.status === "error") {
    if (pool.error instanceof ApiError && pool.error.status === 404) {
      return (
        <EmptyState>
          This user pool doesn&apos;t exist.{" "}
          <Link href={`/workspaces/${id}/user-pools`}>Back to user pools</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={pool.error} onRetry={pool.reload} />;
  }
  const info = pool.data;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  function find(event: FormEvent) {
    event.preventDefault();
    setQuery(search.trim() ? { email: search.trim() } : {});
  }

  const details: [string, string, string][] = [
    ["Pool ID", info.id, "pool ID"],
    ["Issuer (iss)", info.issuer, "issuer"],
    ["Public keys (JWKS)", info.jwksUrl, "public keys URL"],
  ];

  return (
    <>
      <PageHeader
        label="User pool"
        title={info.name}
        description={`${info.userCount} ${info.userCount === 1 ? "user" : "users"}. Access tokens last ${Math.round(info.accessTokenTtlSeconds / 60)} minutes; a session lasts ${Math.round(info.refreshTokenTtlSeconds / 86_400)} days; passwords need at least ${info.minPasswordLength} characters.`}
        actions={
          <Link
            className="button"
            data-variant="ghost"
            href={`/workspaces/${id}/user-pools`}
          >
            All user pools
          </Link>
        }
      />

      <Card title="Connect your app">
        <div className="section">
          <h2>Connect your app</h2>
          <p className="muted">
            Your server calls the API with an API key to sign users up and in.
            Check access tokens with any JWT library, using the public keys
            (ES256): no API key needed for those.
          </p>
          <dl className="details">
            {details.map(([label, value, copyName]) => (
              <div key={label} className="details-row">
                <dt>{label}</dt>
                <dd>
                  <ShortValue value={value} label={copyName} />
                </dd>
              </div>
            ))}
          </dl>
          <pre className="code-block">
            <code>{`POST /v1/user-pools/${info.id}/sessions
Authorization: Bearer <your API key>
{"email": "ada@example.com", "password": "..."}

→ { "accessToken": "<ES256 JWT>", "refreshToken": "...", "expiresIn": ${info.accessTokenTtlSeconds} }`}</code>
          </pre>
        </div>
      </Card>

      <PoolRoles poolId={poolId} />

      <section className="section" aria-labelledby="users-title">
        <div className="row row-between">
          <h2 id="users-title">Users</h2>
          <form className="search-form" role="search" onSubmit={find}>
            <Field
              label="Find by email"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={254}
            />
            <Button type="submit">Search</Button>
          </form>
        </div>
        {users.status === "loading" && <Loading />}
        {users.status === "error" && (
          <ErrorState error={users.error} onRetry={users.reload} />
        )}
        {users.status === "ready" &&
          (users.data.users.length === 0 ? (
            <EmptyState>
              {query.email
                ? "No user's email contains that."
                : "No users yet. Your app signs them up through the API."}
            </EmptyState>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last sign in</th>
                      <th scope="col">Created</th>
                      <th scope="col">
                        <span className="sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.data.users.map((user) => (
                      <tr key={user.id}>
                        <td data-label="Email">{user.email}</td>
                        <td data-label="Status">
                          <PoolUserStatus user={user} />
                        </td>
                        <td data-label="Last sign in">
                          {formatDate(user.lastLoginAt)}
                        </td>
                        <td data-label="Created">
                          {formatDate(user.createdAt)}
                        </td>
                        <td className="actions">
                          <ArrowLink
                            href={`/workspaces/${id}/user-pools/${poolId}/users/${user.id}`}
                            label={`Details of ${user.email}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                next={users.data.nextCursor}
                onNext={(cursor) => setQuery({ ...query, cursor })}
                onFirst={
                  query.cursor
                    ? () => setQuery({ email: query.email })
                    : undefined
                }
              />
            </>
          ))}
      </section>

      {isOwner ? (
        <Card title="Delete user pool">
          <div className="section">
            <h2>Delete user pool</h2>
            <p className="muted">
              Deletes its signing key, every user and every session. Apps using
              it can no longer sign anyone in, and existing tokens can&apos;t be
              checked any more.
            </p>
            <div>
              <Button variant="danger" onClick={() => setDeletingPool(true)}>
                Delete user pool
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Banner title="Viewing as a member">
          Only workspace owners can manage users or delete the pool.
        </Banner>
      )}

      <ConfirmDialog
        open={deletingPool}
        title="Delete user pool"
        confirmLabel="Delete user pool"
        busyLabel="Deleting..."
        busy={busy}
        error={failure}
        onConfirm={() =>
          void run(async () => {
            await api.deletePool(id, poolId);
            toast(`User pool ${info.name} deleted`);
            router.replace(`/workspaces/${id}/user-pools`);
          })
        }
        onCancel={() => {
          setDeletingPool(false);
          setFailure(undefined);
        }}
      >
        <p>
          <strong>{info.name}</strong>, its {info.userCount} users and its
          signing key are deleted. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
