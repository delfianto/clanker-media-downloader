import { describe, it, expect } from "bun:test";
import {
  parseSet,
  deriveGalleryName,
  compareSetsByDateAndSubfolder,
} from "../src/hosts/girlsreleased/api";
import type { MDGalleryStartRequest } from "../src/types/messages";
import sexartSets from "./girlsreleased-sexart-sets.json";

describe("GirlsReleased Sets Sorting", () => {
  it("sorts sets descending by date, and alphabetically ascending by subfolder for matching dates", () => {
    // 1. Mock the set details fetched via the API for each set in the listing response.
    // In actual code, gallery-runner.ts fetches api/0.2/set/{id} which returns:
    // { status: 0, set: { name, url: null, date, site, models: [[id, name]], id, images: [...] } }
    const mockSetResults = sexartSets.sets
      .map((rawSet: any) => {
        const id = rawSet[0] as number;
        const name = rawSet[1] as string;
        const date = rawSet[3] as number;
        const site = rawSet[4] as string;
        const models = rawSet[9] as [number, string][];

        const individualSetPayload = {
          status: 0,
          set: {
            id: id.toString(),
            name,
            url: null,
            date,
            site,
            models,
            images: [
              [0, 0, 0, "https://imx.to/i/dummy", "https://imx.to/u/t/dummy.jpg", "dummy.jpg"],
            ],
          },
        };

        const parsed = parseSet(individualSetPayload);
        if (!parsed) return null;

        const detectedSetName = deriveGalleryName(
          parsed.site,
          parsed.model,
          parsed.name,
          parsed.postedAt,
        );

        // In runner, we build the request:
        const req: MDGalleryStartRequest = {
          type: "MD_GALLERY_START",
          jobId: `job-${id}`,
          hosterId: "girlsreleased",
          subfolder: detectedSetName,
          items: [],
          maxParallelImg: 4,
          maxParallelVid: 1,
          postedAt: parsed.postedAt ?? undefined,
        };

        return { req, postedAt: parsed.postedAt ?? 0 };
      })
      .filter((r): r is { req: MDGalleryStartRequest; postedAt: number } => r !== null);

    // 2. Sort the mock jobs list using the shared sorting function
    mockSetResults.sort((a, b) => {
      return compareSetsByDateAndSubfolder(
        { postedAt: a.postedAt, subfolder: a.req.subfolder },
        { postedAt: b.postedAt, subfolder: b.req.subfolder },
      );
    });

    // 3. Verify the sorted order.
    const subfolders = mockSetResults.map((r) => r.req.subfolder);

    // Date sorting verification:
    // "Sexart/2025.10.16 - ..." should be sorted before "Sexart/2025.10.09 - ..."
    const firstOct16Idx = subfolders.findIndex((s) => s.includes("2025.10.16"));
    const firstOct09Idx = subfolders.findIndex((s) => s.includes("2025.10.09"));
    const firstSep26Idx = subfolders.findIndex((s) => s.includes("2025.09.26"));

    expect(firstOct16Idx).toBeLessThan(firstOct09Idx);
    expect(firstOct09Idx).toBeLessThan(firstSep26Idx);

    // Matching dates alphabetical ascending verification:
    // On 2025.10.16, Foxy Alissa has multiple sets.
    const oct16FoxyAlissa = subfolders.filter((s) => s.includes("2025.10.16 - Foxy Alissa"));

    // Expected order of some sets:
    // Appetizer -> Captivate -> Foxiest -> ... -> Want To Play -> Warm Glow -> Working Up A Sweat
    expect(oct16FoxyAlissa[0]).toContain("Appetizer");
    expect(oct16FoxyAlissa[1]).toContain("Captivate");
    expect(oct16FoxyAlissa[2]).toContain("Foxiest");

    const lastThree = oct16FoxyAlissa.slice(-3);
    expect(lastThree[0]).toContain("Want To Play");
    expect(lastThree[1]).toContain("Warm Glow");
    expect(lastThree[2]).toContain("Working Up A Sweat");

    // On 2025.10.09, Dave Candle / Fanta Sie / Talia Mint sets should be sorted alphabetically:
    const oct09Sets = subfolders.filter((s) => s.includes("2025.10.09"));

    const sortedOct09Sets = [...oct09Sets].sort((a, b) => a.localeCompare(b));
    expect(oct09Sets).toEqual(sortedOct09Sets);
  });
});
