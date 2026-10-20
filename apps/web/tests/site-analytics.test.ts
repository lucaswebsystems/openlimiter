import { describe, expect, it } from "vitest";
import { withCampaignPath } from "@/components/site-analytics";

describe("the campaign written into the recorded path", () => {
  it("records a tagged visit with its source and content in the path", () => {
    expect(withCampaignPath("https://openlimiter.com/download?utm_source=reddit&utm_content=a")).toBe(
      "https://openlimiter.com/download/via/reddit-a?utm_source=reddit&utm_content=a",
    );
  });

  it("keeps the platform of a download click and handles the home page", () => {
    expect(withCampaignPath("https://openlimiter.com/download/started/windows?utm_source=reddit&utm_content=b")).toBe(
      "https://openlimiter.com/download/started/windows/via/reddit-b?utm_source=reddit&utm_content=b",
    );
    expect(withCampaignPath("https://openlimiter.com/?utm_source=Newsletter")).toBe(
      "https://openlimiter.com/via/newsletter?utm_source=Newsletter",
    );
  });

  it("leaves an untagged or unreadable address alone and flattens anything odd", () => {
    expect(withCampaignPath("https://openlimiter.com/download")).toBe("https://openlimiter.com/download");
    expect(withCampaignPath("not a url")).toBe("not a url");
    expect(withCampaignPath("https://openlimiter.com/pricing?utm_source=..%2F..%2Fadmin%20x")).toBe(
      "https://openlimiter.com/pricing/via/admin-x?utm_source=..%2F..%2Fadmin%20x",
    );
  });
});
