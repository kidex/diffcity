import type { Symbol } from '../report/types.js';

/**
 * A symbol extracted from one version (before or after) of a file.
 * `signature` and `body` are normalized so that comparing them decides the
 * status rules of SPEC.md section 5.1; `signatureText` is the source text
 * shown to the reviewer (`signatureBefore` / `signatureAfter`).
 */
export interface ParsedSymbol {
  name: string;
  /** Dotted name including enclosing classes/namespaces, e.g. `InvoiceBook.total`. */
  qualifiedName: string;
  /**
   * `qualifiedName` without the duplicate suffixes, e.g. `Menu.render` for
   * `Menu~2.render`. Status matches symbols on it (plus kind and occurrence).
   */
  baseQualifiedName: string;
  kind: Symbol['kind'];
  /** 1-based inclusive line range in the parsed version. */
  range: Symbol['range'];
  /** Normalized signature (parameters, types, return). */
  signature: string;
  /** Normalized body. */
  body: string;
  /** Signature as written in the source. */
  signatureText: string;
}
