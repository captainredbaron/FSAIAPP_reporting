import Link from "next/link";
import { format } from "date-fns";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getChecklistSectionsByVersion,
  listAdminClients,
  listAssignments,
  listClientChecklistVersions,
  listClientLocations,
  listClientRoleMembers,
  type AssignmentStatus
} from "@/lib/admin/client-admin";
import {
  createAssignmentAction,
  createChecklistDraftAction,
  createClientAction,
  publishChecklistVersionAction,
  saveLocationAction,
  setClientRoleAction,
  updateAssignmentAction
} from "./actions";

type SearchParams = Record<string, string | string[] | undefined>;
type AdminTab = "clients" | "checklists" | "assignments";

const tabOptions: Array<{ id: AdminTab; label: string }> = [
  { id: "clients", label: "Clients" },
  { id: "checklists", label: "Checklist Builder" },
  { id: "assignments", label: "Assignments" }
];

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseTab(value: string | undefined): AdminTab {
  if (value === "clients" || value === "checklists" || value === "assignments") {
    return value;
  }
  return "clients";
}

function parseAssignmentFilter(value: string | undefined): AssignmentStatus | "all" {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "overdue" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "all";
}

function toDatetimeLocalValue(iso: string) {
  const date = new Date(iso);
  const normalized = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return normalized.toISOString().slice(0, 16);
}

export default async function ReportingAdminPage({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const tab = parseTab(firstValue(params.tab));
  const assignmentFilter = parseAssignmentFilter(firstValue(params.status));

  const supabase = await createServerSupabaseClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const adminClients = await listAdminClients(user.id);
  const selectedClientIdRaw = firstValue(params.client);
  const selectedClientId =
    selectedClientIdRaw && adminClients.some((client) => client.id === selectedClientIdRaw)
      ? selectedClientIdRaw
      : adminClients[0]?.id ?? null;

  if (!selectedClientId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Admin Access Required</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            No owner/manager client roles were found for your account. Ask an existing owner to
            map your role in client settings.
          </p>
          <form action={createClientAction} className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-foreground">Create your first client</p>
            <Input name="name" placeholder="Client name" required />
            <Input name="code" placeholder="Client code (optional)" />
            <Button type="submit" size="sm">
              Create Client
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  const selectedClient = adminClients.find((client) => client.id === selectedClientId)!;

  const [locations, roleMembers, checklistVersions] = await Promise.all([
    listClientLocations(selectedClientId, user.id),
    listClientRoleMembers(selectedClientId, user.id),
    listClientChecklistVersions(selectedClientId, user.id)
  ]);

  const publishedChecklistVersions = checklistVersions.filter((row) => row.status === "published");
  const assignableMembers = roleMembers.filter((row) => row.role !== "viewer");

  const selectedVersionIdRaw = firstValue(params.version);
  const selectedVersionId =
    selectedVersionIdRaw &&
    checklistVersions.some((version) => version.id === selectedVersionIdRaw)
      ? selectedVersionIdRaw
      : checklistVersions[0]?.id ?? null;

  const [selectedVersionSections, assignments] = await Promise.all([
    selectedVersionId
      ? getChecklistSectionsByVersion({
          clientId: selectedClientId,
          versionId: selectedVersionId,
          userId: user.id
        })
      : Promise.resolve([]),
    tab === "assignments"
      ? listAssignments({
          userId: user.id,
          clientId: selectedClientId,
          status: assignmentFilter
        })
      : Promise.resolve([])
  ]);

  return (
    <div className="space-y-5 pb-8">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Admin</h2>
          <p className="text-sm text-muted-foreground">
            Client-specific checklist management and assignment orchestration.
          </p>
        </div>
      </section>

      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            {tabOptions.map((tabOption) => (
              <Button
                key={tabOption.id}
                variant={tabOption.id === tab ? "default" : "outline"}
                size="sm"
                asChild
              >
                <Link
                  href={`/reporting/admin?tab=${tabOption.id}&client=${selectedClientId}${
                    tabOption.id === "assignments" ? `&status=${assignmentFilter}` : ""
                  }`}
                >
                  {tabOption.label}
                </Link>
              </Button>
            ))}
          </div>

          <form method="get" action="/reporting/admin" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value={tab} />
            <Label htmlFor="client" className="text-sm">
              Client
            </Label>
            <select
              id="client"
              name="client"
              defaultValue={selectedClientId}
              className="h-10 min-w-[260px] rounded-md border border-input bg-background px-3 text-sm"
            >
              {adminClients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name} ({client.my_role})
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline">
              Switch
            </Button>
          </form>

          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <span className="font-medium">{selectedClient.name}</span>
            {selectedClient.code ? ` • ${selectedClient.code}` : ""} •{" "}
            {selectedClient.active ? "Active" : "Inactive"}
          </div>
        </CardContent>
      </Card>

      {tab === "clients" ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Client</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={createClientAction} className="space-y-2">
                <Input name="name" placeholder="Client name" required />
                <Input name="code" placeholder="Client code (optional)" />
                <Button type="submit" size="sm">
                  Create
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Locations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <form action={saveLocationAction} className="grid gap-2">
                <input type="hidden" name="client_id" value={selectedClientId} />
                <Input name="name" placeholder="Location name" required />
                <Input name="address" placeholder="Address (optional)" />
                <Button type="submit" size="sm">
                  Add Location
                </Button>
              </form>

              <div className="space-y-2">
                {locations.length > 0 ? (
                  locations.map((location) => (
                    <form
                      key={location.id}
                      action={saveLocationAction}
                      className="grid gap-2 rounded-lg border border-border p-3"
                    >
                      <input type="hidden" name="client_id" value={selectedClientId} />
                      <input type="hidden" name="location_id" value={location.id} />
                      <Input name="name" defaultValue={location.name} required />
                      <Input
                        name="address"
                        defaultValue={location.address ?? ""}
                        placeholder="Address"
                      />
                      <select
                        name="active"
                        defaultValue={location.active ? "true" : "false"}
                        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="true">Active</option>
                        <option value="false">Inactive</option>
                      </select>
                      <Button type="submit" size="sm" variant="outline">
                        Save
                      </Button>
                    </form>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No locations yet.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">User Role Mapping</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <form action={setClientRoleAction} className="grid gap-2 sm:grid-cols-4">
                <input type="hidden" name="client_id" value={selectedClientId} />
                <Input
                  name="email"
                  className="sm:col-span-2"
                  placeholder="user@email.com"
                  required
                />
                <select
                  name="role"
                  defaultValue="manager"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="owner">owner</option>
                  <option value="manager">manager</option>
                  <option value="auditor">auditor</option>
                  <option value="viewer">viewer</option>
                </select>
                <Button type="submit" size="sm">
                  Save Role
                </Button>
              </form>

              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roleMembers.length > 0 ? (
                      roleMembers.map((member) => (
                        <tr key={member.id} className="border-t border-border">
                          <td className="px-3 py-2">{member.email ?? "-"}</td>
                          <td className="px-3 py-2">{member.full_name ?? "-"}</td>
                          <td className="px-3 py-2">
                            <Badge variant="outline">{member.role}</Badge>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="px-3 py-4 text-muted-foreground">
                          No mapped users yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {tab === "checklists" ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Draft Version</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <form action={createChecklistDraftAction} className="space-y-2">
                <input type="hidden" name="client_id" value={selectedClientId} />
                <Input name="title" placeholder="Draft title (e.g. Q2 2026)" required />
                <textarea
                  name="sections"
                  required
                  rows={10}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder={
                    "Format per line: SECTION_CODE|Section Title|Optional description\nKITCHEN|Kitchen|Core kitchen controls"
                  }
                />
                <Button type="submit" size="sm">
                  Save Draft
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">
                Publish a draft to create an immutable active checklist version for assignments.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Versions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {checklistVersions.length > 0 ? (
                checklistVersions.map((version) => (
                  <div key={version.id} className="rounded-lg border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          v{version.version_no} • {version.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {version.status}
                          {version.published_at
                            ? ` • published ${format(new Date(version.published_at), "PP p")}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {version.is_active ? <Badge>Active</Badge> : null}
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            href={`/reporting/admin?tab=checklists&client=${selectedClientId}&version=${version.id}`}
                          >
                            View
                          </Link>
                        </Button>
                        {version.status !== "published" ? (
                          <form action={publishChecklistVersionAction}>
                            <input type="hidden" name="client_id" value={selectedClientId} />
                            <input type="hidden" name="version_id" value={version.id} />
                            <Button type="submit" size="sm">
                              Publish
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No checklist versions yet.</p>
              )}
            </CardContent>
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Version Sections</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {selectedVersionId ? (
                selectedVersionSections.length > 0 ? (
                  selectedVersionSections.map((section) => (
                    <div
                      key={section.id}
                      className="rounded-lg border border-border bg-muted/20 p-3 text-sm"
                    >
                      <p className="font-medium">
                        {section.sort_order}. {section.section_title}
                      </p>
                      <p className="text-xs text-muted-foreground">{section.section_code}</p>
                      {section.description ? (
                        <p className="text-xs text-muted-foreground">{section.description}</p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Selected version has no section items.
                  </p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">Select a version to preview sections.</p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {tab === "assignments" ? (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Assignment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <form action={createAssignmentAction} className="grid gap-2 md:grid-cols-5">
                <input type="hidden" name="client_id" value={selectedClientId} />
                <select
                  name="location_id"
                  required
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Location</option>
                  {locations
                    .filter((location) => location.active)
                    .map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                </select>
                <select
                  name="assignee_user_id"
                  required
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Assignee</option>
                  {assignableMembers.map((member) => (
                    <option key={member.id} value={member.user_id}>
                      {member.email ?? member.user_id} ({member.role})
                    </option>
                  ))}
                </select>
                <select
                  name="checklist_version_id"
                  required
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Checklist version</option>
                  {publishedChecklistVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      v{version.version_no} - {version.title}
                      {version.is_active ? " (active)" : ""}
                    </option>
                  ))}
                </select>
                <Input name="due_at" type="datetime-local" required />
                <Button type="submit" size="sm">
                  Assign
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">
                Assignee must be mapped as owner/manager/auditor. Cancelled assignments cannot be
                started.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-3">
              <CardTitle className="text-base">Assignments</CardTitle>
              <form method="get" action="/reporting/admin" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="tab" value="assignments" />
                <input type="hidden" name="client" value={selectedClientId} />
                <select
                  name="status"
                  defaultValue={assignmentFilter}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="all">all</option>
                  <option value="pending">pending</option>
                  <option value="in_progress">in_progress</option>
                  <option value="completed">completed</option>
                  <option value="overdue">overdue</option>
                  <option value="cancelled">cancelled</option>
                </select>
                <Button type="submit" size="sm" variant="outline">
                  Filter
                </Button>
              </form>
            </CardHeader>
            <CardContent className="space-y-2">
              {assignments.length > 0 ? (
                assignments.map((assignment) => (
                  <form
                    key={assignment.id}
                    action={updateAssignmentAction}
                    className="grid gap-2 rounded-lg border border-border p-3 md:grid-cols-6"
                  >
                    <input type="hidden" name="client_id" value={selectedClientId} />
                    <input type="hidden" name="assignment_id" value={assignment.id} />
                    <div className="md:col-span-2">
                      <p className="text-sm font-medium">{assignment.location_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {assignment.assignee_email} • {assignment.checklist_title} (v
                        {assignment.checklist_version_no})
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Due {format(new Date(assignment.due_at), "PP p")}
                      </p>
                      {assignment.inspection_id ? (
                        <Link
                          href={`/reporting/inspections/${assignment.inspection_id}`}
                          className="text-xs text-primary underline"
                        >
                          Open inspection
                        </Link>
                      ) : null}
                    </div>

                    <select
                      name="assignee_user_id"
                      defaultValue={assignment.assignee_user_id}
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {assignableMembers.map((member) => (
                        <option key={member.id} value={member.user_id}>
                          {member.email ?? member.user_id}
                        </option>
                      ))}
                    </select>

                    <Input
                      name="due_at"
                      type="datetime-local"
                      defaultValue={toDatetimeLocalValue(assignment.due_at)}
                    />

                    <select
                      name="status"
                      defaultValue={assignment.status}
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="pending">pending</option>
                      <option value="in_progress">in_progress</option>
                      <option value="completed">completed</option>
                      <option value="overdue">overdue</option>
                      <option value="cancelled">cancelled</option>
                    </select>

                    <Button type="submit" size="sm" variant="outline">
                      Update
                    </Button>
                  </form>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No assignments for current filter.</p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
