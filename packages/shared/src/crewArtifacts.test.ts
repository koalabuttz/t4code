import { describe, expect, it } from "vite-plus/test";
import {
  parseCrewArtifact,
  crewReviewLabel,
  crewIncludedSubmissionLabel,
  crewIntegratedArtifacts,
} from "./crewArtifacts.ts";

describe("Crew artifact review", () => {
  it("validates immutable commit and non-code content artifacts", () => {
    const commit = "a".repeat(40);
    const sha256 = "b".repeat(64);
    expect(parseCrewArtifact("commit", commit, "")).toEqual({ kind: "commit", ref: commit });
    expect(parseCrewArtifact("commit", sha256, "docs/report.md")).toEqual({
      kind: "commit",
      ref: sha256,
      path: "docs/report.md",
    });
    expect(parseCrewArtifact("content", sha256, " reports/result.pdf ")).toEqual({
      kind: "content",
      ref: sha256,
      path: "reports/result.pdf",
    });
    expect(parseCrewArtifact("content", sha256, " ")).toBeNull();
    expect(parseCrewArtifact("content", commit, "report.pdf")).toBeNull();
    expect(parseCrewArtifact("commit", "main", "")).toBeNull();
    expect(parseCrewArtifact("commit", "a".repeat(39), "")).toBeNull();
    expect(parseCrewArtifact("content", sha256, "a".repeat(2001))).toBeNull();
  });

  it("requires review of the current submission and preserves historical inclusion", () => {
    const review = { decision: "approve" as const, submissionRevision: 3 };
    expect(crewReviewLabel({ status: "done", submission: { revision: 3 }, review })).toBe(
      "Accepted submission 3",
    );
    expect(crewReviewLabel({ status: "review", submission: { revision: 3 }, review: null })).toBe(
      "Submission 3 needs review",
    );
    expect(
      crewReviewLabel({
        status: "review",
        submission: { revision: 3 },
        review: { decision: "changes", submissionRevision: 3 },
      }),
    ).toBe("Changes requested for submission 3");
    expect(crewReviewLabel({ status: "review", submission: { revision: 4 }, review })).toBe(
      "Submission 4 needs fresh review; recorded review is for submission 3.",
    );
    expect(
      crewReviewLabel({
        status: "done",
        submission: { revision: 4 },
        review: { decision: "approve" },
      }),
    ).toBe("Submission 4 needs fresh review; recorded review has no submission revision.");
    expect(
      crewIncludedSubmissionLabel({ taskId: "report", revision: 3 }, [
        { id: "report", title: "Report", submission: { revision: 4 } },
      ]),
    ).toBe("Report · included submission 3 · replaced by submission 4");
    expect(crewIncludedSubmissionLabel({ taskId: "report", revision: 3 }, [])).toBe(
      "report · included submission 3 · current submission unavailable",
    );
    expect(
      crewIncludedSubmissionLabel({ taskId: "report", revision: 3 }, [
        { id: "report", title: "Report", submission: { revision: 3 } },
      ]),
    ).toBe("Report · included submission 3");
  });

  it("offers only recorded integrated artifacts, never worker submissions", () => {
    const artifact = { kind: "content" as const, ref: "b".repeat(64), path: "report.pdf" };
    expect(
      crewIntegratedArtifacts({
        milestones: [
          { id: "delivery", title: "Delivery", verification: { artifact } },
          { id: "pending", title: "Pending" },
        ],
      }),
    ).toEqual([{ milestoneId: "delivery", title: "Delivery", artifact }]);
    const workerOnly = { milestones: [], tasks: [{ submission: { artifact } }] };
    expect(crewIntegratedArtifacts(workerOnly)).toEqual([]);
  });
});
