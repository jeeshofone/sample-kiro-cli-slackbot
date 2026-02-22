import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.js";

export type Project = { name: string; cwd: string; agent: string };

const PROJECTS_FILE = resolve(import.meta.dirname, "../../projects.json");

function load(): Project[] {
  if (!existsSync(PROJECTS_FILE)) return [];
  try { return JSON.parse(readFileSync(PROJECTS_FILE, "utf-8")); } catch { return []; }
}

function save(projects: Project[]): void {
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n");
}

let projects: Project[] = load();
logger.info({ count: projects.length, names: projects.map((p) => p.name) }, "loaded projects");

export function parseProject(text: string): { project: Project | null; rest: string } {
  const match = text.match(/^\[([^\]]+)\]\s*(.*)/s);
  if (!match) return { project: null, rest: text };
  const name = match[1].trim().toLowerCase();
  const found = projects.find((p) => p.name.toLowerCase() === name);
  return { project: found ?? null, rest: found ? match[2].trim() : text };
}

export function listProjects(): Project[] {
  return projects;
}

export function addProject(project: Project): void {
  projects = projects.filter((p) => p.name.toLowerCase() !== project.name.toLowerCase());
  projects.push(project);
  save(projects);
}

export function removeProject(name: string): boolean {
  const before = projects.length;
  projects = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  if (projects.length === before) return false;
  save(projects);
  return true;
}
