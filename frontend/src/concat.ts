/**
 * Append MusicXML `addition` to `base`, treating both as score-partwise.
 * Measures from `addition` are extracted, renumbered to follow `base`'s
 * last measure number, and inserted right before `</part>` in `base`.
 *
 * Limitations (acceptable for now):
 *   - Single-part scores. If either side has multiple <part>s only the first matters.
 *   - The appended measures keep their internal <attributes> (key/clef/time changes
 *     mid-piece are valid MusicXML, OSMD handles them), so the join may visibly
 *     reset the clef/key — that's correct if the appended page actually uses
 *     different settings.
 */
export function appendMusicXML(base: string, addition: string): string {
  if (!base) return addition;
  const partCloseIdx = base.lastIndexOf("</part>");
  if (partCloseIdx < 0) return base;
  const head = base.slice(0, partCloseIdx);
  const tail = base.slice(partCloseIdx);
  let measureNum = (head.match(/<measure\b/g) || []).length;
  const matches = addition.match(/<measure\b[\s\S]*?<\/measure>/g) || [];
  let extra = "";
  for (const m of matches) {
    measureNum++;
    extra += m.replace(
      /<measure\s+number="[^"]*"/,
      `<measure number="${measureNum}"`,
    );
  }
  return head + extra + tail;
}
