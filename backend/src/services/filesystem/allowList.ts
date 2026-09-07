/**
 * AllowList — the backend equivalent of the desktop's Rust AllowList.
 *
 * Phase 9.2 introduces this as a stand-alone, fail-closed authorization
 * boundary for the backend's filesystem service. The model intentionally
 * mirrors the desktop's Phase 8.2 implementation so the same security
 * semantics apply on both sides:
 *
 *   - roots are canonicalized before being added (no `..`, no symlinked
 *     ancestors sneaking in);
 *   - membership is component-aware (a path is allowed only if it is a root
 *     or a strict descendant of a root, by path component — never by raw
 *     string prefix);
 *   - an empty list denies every path (fail closed);
 *   - duplicate root registrations are ignored.
 *
 * The tool layer never accesses the filesystem directly. Every read-only
 * tool funnels its canonicalized target through `isAllowed` before
 * touching `fs`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A canonical absolute path. We do not narrow this at the type level
 * because `fs.realpathSync` already returns an absolute, symlink-resolved
 * string.
 */
export type CanonicalPath = string;

export class AllowList {
  private readonly roots: CanonicalPath[] = [];

  private constructor(roots: CanonicalPath[]) {
    this.roots = roots;
  }

  /**
   * Build a registry with NO roots. Every `isAllowed` call returns false.
   * Use this whenever configuration is missing — never as a permissive
   * default.
   */
  static empty(): AllowList {
    return new AllowList([]);
  }

  /**
   * Build a registry from pre-canonicalized roots. Duplicate roots are
   * collapsed. The list is sorted (longest first) so containment checks
   * prefer the most specific root, which keeps `startsWith` semantics
   * component-correct when roots are nested.
   */
  static fromCanonicalRoots(roots: readonly CanonicalPath[]): AllowList {
    const seen = new Set<string>();
    const unique: CanonicalPath[] = [];
    for (const root of roots) {
      if (!seen.has(root)) {
        seen.add(root);
        unique.push(root);
      }
    }
    unique.sort((a, b) => b.length - a.length);
    return new AllowList(unique);
  }

  /**
   * Build a registry with a single root. The root is canonicalized
   * (must exist and be a directory). Returns null on failure so the caller
   * can fall back to `empty()` rather than an unrestricted registry.
   */
  static withRoot(root: string): AllowList | null {
    const canonical = AllowList.tryCanonicalizeDirectory(root);
    if (canonical === null) return null;
    return AllowList.fromCanonicalRoots([canonical]);
  }

  /**
   * Register an additional root. The root is canonicalized. Duplicate
   * canonical roots (after normalization) are ignored. Returns true if
   * a new root was added.
   */
  registerRoot(root: string): boolean {
    const canonical = AllowList.tryCanonicalizeDirectory(root);
    if (canonical === null) return false;
    if (this.roots.includes(canonical)) return false;
    // Keep the roots sorted (longest first) for correct containment checks.
    const next = [...this.roots, canonical].sort((a, b) => b.length - a.length);
    this.roots.length = 0;
    this.roots.push(...next);
    return true;
  }

  get length(): number {
    return this.roots.length;
  }

  /** Read-only view of the canonical allowed roots. */
  getRoots(): readonly CanonicalPath[] {
    return [...this.roots];
  }

  /**
   * Component-aware canonical membership. Empty registry → false (fail
   * closed). The path is treated as already-canonical; callers MUST run
   * it through `realpath` first.
   */
  isAllowed(canonical: string): boolean {
    if (this.roots.length === 0) return false;
    if (this.roots.includes(canonical)) return true;
    for (const root of this.roots) {
      if (AllowList.isStrictDescendant(canonical, root)) return true;
    }
    return false;
  }

  /**
   * True iff `child` is strictly inside `parent` by path component.
   * Pure string check — no filesystem access.
   */
  private static isStrictDescendant(child: string, parent: string): boolean {
    if (child === parent) return false;
    const parentWithSep = parent.endsWith(path.sep)
      ? parent
      : parent + path.sep;
    return child.startsWith(parentWithSep);
  }

  /**
   * Canonicalize an existing directory. Returns null on any failure
   * (does not exist, not a directory, permission denied, etc.) so the
   * caller can fall back to a fail-closed configuration.
   */
  static tryCanonicalizeDirectory(input: string): CanonicalPath | null {
    if (typeof input !== "string" || input.length === 0) return null;
    try {
      // realpath resolves symlinks; we additionally verify it is a
      // directory so a stray file cannot become an allowed root.
      const canonical = fs.realpathSync(input);
      const stat = fs.statSync(canonical);
      if (!stat.isDirectory()) return null;
      return canonical;
    } catch {
      return null;
    }
  }

  /**
   * Canonicalize an arbitrary path (file or directory) for use with
   * `isAllowed`. Returns null on failure.
   */
  static tryCanonicalize(input: string): CanonicalPath | null {
    if (typeof input !== "string" || input.length === 0) return null;
    try {
      return fs.realpathSync(input);
    } catch {
      return null;
    }
  }
}
