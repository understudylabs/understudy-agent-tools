import { z } from "zod";

import { readProjectConfig } from "../config/index.js";
import { request, resolveAuth, type ResolvedAuth } from "./http.js";

export const ProjectSchema = z.object({
  id: z.string(),
  org_id: z.string().optional(),
  slug: z.string(),
  name: z.string().optional(),
  created_at: z.string().optional(),
  settings: z.string().optional(),
  deleted_at: z.string().nullable().optional(),
}).passthrough();

const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  cursor: z.string().nullable().optional(),
}).passthrough();

export type Project = z.infer<typeof ProjectSchema>;

export interface ProjectResolutionOptions {
  org?: string;
  projectId?: string;
  project?: string;
}

export interface ResolvedProject {
  auth: ResolvedAuth;
  projectId: string;
  projectSlug: string | null;
  project: Project | null;
}

export function resolveOrganizationAuth(org?: string): ResolvedAuth {
  return resolveAuth(org ?? readProjectConfig()?.org_id);
}

export async function listProjects(auth: ResolvedAuth): Promise<Project[]> {
  const projects: Project[] = [];
  let cursor: string | null = null;
  while (true) {
    const url: string = cursor
      ? `/admin/v1/orgs/${auth.orgId}/projects?cursor=${encodeURIComponent(cursor)}`
      : `/admin/v1/orgs/${auth.orgId}/projects`;
    const res: Awaited<ReturnType<typeof request<z.infer<typeof ListProjectsResponseSchema>>>> = await request({ url, orgId: auth.orgId }, ListProjectsResponseSchema);
    projects.push(...res.data.projects);
    cursor = res.data.cursor ?? null;
    if (!cursor) break;
  }
  return projects;
}

export async function resolveProject(opts: ProjectResolutionOptions): Promise<ResolvedProject> {
  const config = readProjectConfig();
  const auth = resolveOrganizationAuth(opts.org ?? config?.org_id);

  if (opts.projectId) {
    return {
      auth,
      projectId: opts.projectId,
      projectSlug: null,
      project: null,
    };
  }

  const slug = opts.project ?? config?.project_slug;
  if (!slug) {
    throw new Error("No project selected. Run `understudy projects list` or pass --project-id.");
  }

  const projects = await listProjects(auth);
  const project = projects.find((candidate) => candidate.slug === slug);
  if (!project) {
    throw new Error(`No project with slug "${slug}" in org ${auth.orgId}. Run \`understudy projects list\` to see what's available.`);
  }

  return {
    auth,
    projectId: project.id,
    projectSlug: project.slug,
    project,
  };
}
