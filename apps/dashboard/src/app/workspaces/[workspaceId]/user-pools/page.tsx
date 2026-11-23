"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  ArrowLink,
  Banner,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  formatDate,
} from "@/components/ui";
import { ApiError } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export default function UserPoolsPage() {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const pools = useLoad(() => api.pools(id), [id]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [accessMinutes, setAccessMinutes] = useState("15");
  const [refreshDays, setRefreshDays] = useState("30");
  const [minLength, setMinLength] = useState("12");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  function close() {
    setCreating(false);
    setErrors({});
    setFailure(undefined);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    const access = Number(accessMinutes);
    const refresh = Number(refreshDays);
    const length = Number(minLength);
    if (!NAME_PATTERN.test(name.trim())) {
      found.name =
        "Use 1 to 64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.";
    }
    if (!Number.isInteger(access) || access < 1 || access > 1440) {
      found.access = "Between 1 and 1,440 minutes.";
    }
    if (!Number.isInteger(refresh) || refresh < 1 || refresh > 90) {
      found.refresh = "Between 1 and 90 days.";
    }
    if (!Number.isInteger(length) || length < 12 || length > 64) {
      found.length = "Between 12 and 64 characters.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const pool = await api.createPool(id, {
        name: name.trim(),
        accessTokenTtlSeconds: access * 60,
        refreshTokenTtlSeconds: refresh * 86_400,
        minPasswordLength: length,
      });
      toast(`User pool ${pool.name} created`);
      setName("");
      close();
      pools.reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ name: "A pool with this name already exists." });
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        label="User management"
        title="User pools"
        description="Your app's own users: they sign up and sign in through the API, with signed tokens your app checks itself."
        actions={
          isOwner && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create user pool
            </Button>
          )
        }
      />
      {!isOwner && (
        <Banner title="Viewing as a member">
          Only workspace owners can create pools or manage their users.
        </Banner>
      )}

      {pools.status === "loading" && <Loading />}
      {pools.status === "error" && (
        <ErrorState error={pools.error} onRetry={pools.reload} />
      )}
      {pools.status === "ready" &&
        (pools.data.pools.length === 0 ? (
          <EmptyState>
            No user pools yet.{" "}
            {isOwner
              ? "Create one for each app whose users should sign in."
              : "An owner can create one."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Users</th>
                  <th scope="col">Access tokens</th>
                  <th scope="col">Session lasts</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pools.data.pools.map((pool) => (
                  <tr key={pool.id}>
                    <td data-label="Name">
                      <Link href={`/workspaces/${id}/user-pools/${pool.id}`}>
                        {pool.name}
                      </Link>
                    </td>
                    <td data-label="Users">{pool.userCount}</td>
                    <td data-label="Access tokens">
                      {Math.round(pool.accessTokenTtlSeconds / 60)} min
                    </td>
                    <td data-label="Session lasts">
                      {Math.round(pool.refreshTokenTtlSeconds / 86_400)} days
                    </td>
                    <td data-label="Created">{formatDate(pool.createdAt)}</td>
                    <td className="actions">
                      <ArrowLink
                        href={`/workspaces/${id}/user-pools/${pool.id}`}
                        label={`Details of ${pool.name}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <Dialog open={creating} title="Create user pool" onClose={close}>
        <form
          className="form"
          onSubmit={(event) => void create(event)}
          noValidate
        >
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="For example Shop customers."
            error={errors.name}
            maxLength={64}
            autoFocus
          />
          <Field
            label="Access token lifetime (minutes)"
            type="number"
            inputMode="numeric"
            value={accessMinutes}
            onChange={(e) => setAccessMinutes(e.target.value)}
            hint="Short is safer: a stolen token stops working sooner. 15 by default."
            error={errors.access}
          />
          <Field
            label="Session lifetime (days)"
            type="number"
            inputMode="numeric"
            value={refreshDays}
            onChange={(e) => setRefreshDays(e.target.value)}
            hint="How long a refresh token keeps a user signed in. 30 by default."
            error={errors.refresh}
          />
          <Field
            label="Minimum password length"
            type="number"
            inputMode="numeric"
            value={minLength}
            onChange={(e) => setMinLength(e.target.value)}
            hint="12 or more. Very common passwords are always refused."
            error={errors.length}
          />
          <FormError error={failure} />
          <div className="form-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create user pool"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
