"use client";

import Link from "next/link";
import { describePolicy } from "@/components/policy";
import {
  ArrowLink,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Status,
  formatDate,
} from "@/components/ui";
import { workspace as api } from "@/lib/api/endpoints";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

export default function ConnectionsPage() {
  const { id, isOwner } = useWorkspace();
  const list = useLoad(() => api.connections(id), [id]);

  return (
    <>
      <PageHeader
        label="Workspace"
        title="Connections"
        description="Call an outside API through the proxy route, with one of your secrets added to each request. A policy limits what apps may do through it."
        actions={
          isOwner && (
            <Link
              className="button"
              data-variant="primary"
              href={`/workspaces/${id}/connections/new`}
            >
              Create connection
            </Link>
          )
        }
      />
      {list.status === "loading" && <Loading />}
      {list.status === "error" && (
        <ErrorState error={list.error} onRetry={list.reload} />
      )}
      {list.status === "ready" &&
        (list.data.connections.length === 0 ? (
          <EmptyState>
            No connections yet.{" "}
            {isOwner
              ? "Create one to call an outside API with a stored secret."
              : "An owner can create one."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Base URL</th>
                  <th scope="col">Secret</th>
                  <th scope="col">Policy</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.connections.map((connection) => (
                  <tr key={connection.name}>
                    <td data-label="Name">
                      <code>{connection.name}</code>
                    </td>
                    <td data-label="Base URL" className="mono">
                      {connection.baseUrl}
                    </td>
                    <td data-label="Secret">
                      <code>{connection.secretName}</code>
                    </td>
                    <td data-label="Policy">
                      {connection.policy ? (
                        <Status tone="info">
                          {describePolicy(connection.policy).length}{" "}
                          {describePolicy(connection.policy).length === 1
                            ? "limit"
                            : "limits"}
                        </Status>
                      ) : (
                        <Status>No policy</Status>
                      )}
                    </td>
                    <td data-label="Updated">
                      {formatDate(connection.updatedAt)}
                    </td>
                    <td className="actions">
                      <ArrowLink
                        href={`/workspaces/${id}/connections/${encodeURIComponent(connection.name)}`}
                        label={`Details of ${connection.name}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
