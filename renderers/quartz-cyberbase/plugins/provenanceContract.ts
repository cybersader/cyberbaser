// Renderer-neutral, versioned emission boundary. No Quartz, filesystem or DOM APIs.
export type SourceIdentity = {
  path: string;
  byteLength: number;
  sha256: string;
};
export type ProvenanceRun = {
  rendered: [number, number]; // UTF-16 offsets in the unnormalized DOM Text.data
  source?: [number, number]; // half-open UTF-8 bytes, complete Unicode boundaries
  kind?: "exact" | "atom";
  reason?: string;
};
export type ProvenanceLeaf = {
  id: string;
  parent: string; // data-cb-node, or "$body" for the source body root
  child: number; // childNodes index, not element.children index
  text: string; // browser must compare exactly before using any run
  runs: ProvenanceRun[];
  exact?: [number, number]; // present only when the entire text is one exact source slice
};
export type ProvenanceBlock = {
  id: string;
  parent: string; // data-cb-node on the enclosing rendered block element
  source: [number, number]; // original half-open UTF-8 bytes, including Markdown syntax
} & (
  | { editable: true; text: string; reason?: never }
  | { editable: false; reason: string; text?: never }
);
export const MAX_PROVENANCE_BLOCK_BYTES = 8 * 1024;
export const MAX_PROVENANCE_SIDECAR_BYTES = 4 * 1024 * 1024;
export type ProvenanceManifest = {
  schema: "cyberbaser.source-provenance";
  version: 2;
  source: SourceIdentity;
  leaves: ProvenanceLeaf[];
  blocks: ProvenanceBlock[];
};
export interface ProvenanceSink {
  write(page: string, manifest: ProvenanceManifest): void;
}
export function emitProvenance(
  sink: ProvenanceSink,
  page: string,
  source: SourceIdentity,
  leaves: ProvenanceLeaf[],
  blocks: ProvenanceBlock[] = [],
) {
  const encoder = new TextEncoder();
  const withoutText = (
    block: ProvenanceBlock,
    reason: string,
  ): ProvenanceBlock => ({
    id: block.id,
    parent: block.parent,
    source: block.source,
    editable: false,
    reason,
  });
  const manifest: ProvenanceManifest = {
    schema: "cyberbaser.source-provenance",
    version: 2,
    source,
    leaves,
    blocks: blocks.map((block) =>
      !block.editable
        ? withoutText(block, block.reason)
        : encoder.encode(block.text).length > MAX_PROVENANCE_BLOCK_BYTES
          ? withoutText(block, "too-large")
          : block,
    ),
  };
  const size = () => encoder.encode(JSON.stringify(manifest) + "\n").length;
  if (size() > MAX_PROVENANCE_SIDECAR_BYTES) {
    manifest.blocks = manifest.blocks.map((block) =>
      withoutText(block, block.editable ? "too-large" : block.reason),
    );
    // Rendered text is also bounded. An enormous page fails closed for in-place
    // editing rather than writing an oversized manifest or a partial text map.
    if (size() > MAX_PROVENANCE_SIDECAR_BYTES) manifest.leaves = [];
    if (size() > MAX_PROVENANCE_SIDECAR_BYTES)
      throw Error("source provenance metadata exceeds sidecar size cap");
  }
  sink.write(page, manifest);
  return manifest;
}
