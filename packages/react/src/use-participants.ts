import { useEffect, useState, useCallback } from "react";
import type { Doc, ParticipantInfo } from "@pokapali/core";

/**
 * Subscribe to the doc's awareness and return the
 * current participant map. Re-renders on awareness
 * change events.
 */
export function useParticipants(
  doc: Doc,
): ReadonlyMap<number, ParticipantInfo> {
  const [participants, setParticipants] = useState<
    ReadonlyMap<number, ParticipantInfo>
  >(() => doc.participants);

  const update = useCallback(() => {
    setParticipants(doc.participants);
  }, [doc]);

  useEffect(() => {
    update();
    doc.awareness.on("change", update);
    return () => {
      doc.awareness.off("change", update);
    };
  }, [doc, update]);

  return participants;
}
