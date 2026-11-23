// The selected card's line in the project tab strip: name, "project / branch", "Kartı sil" (confirmed), and the
// engine's refusal. No terminal launcher — terminals are opened from the Terminal panel.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardBar, defaultCardBarText } from "./CardBar.tsx";
import { makeCard } from "./test-utils/fake-client.ts";

afterEach(cleanup);

const card = makeCard("a", "p1", "Kart A");
const bar = () => screen.getByRole("group", { name: defaultCardBarText.label });
const button = (name: string) => within(bar()).getByRole("button", { name });

describe("CardBar", () => {
  it("is one group: the card's name as a heading, project / branch, and Kartı sil — no launcher", () => {
    render(<CardBar card={card} projectName="Alfa" onDelete={async () => {}} />);
    expect(within(bar()).getByRole("heading", { level: 2, name: "Kart A" })).toBeTruthy();
    expect(within(bar()).getByText("Alfa / kokpit/a")).toBeTruthy();
    expect(within(bar()).getAllByRole("button").map((b) => b.textContent)).toEqual([defaultCardBarText.remove]);
    expect(bar().querySelector("form, select, input")).toBeNull();
    // Long names are cut with an ellipsis; the full text stays in the tooltip.
    expect(within(bar()).getByRole("heading").getAttribute("title")).toBe("Kart A");
    expect(within(bar()).getByText("Alfa / kokpit/a").getAttribute("title")).toBe("Alfa / kokpit/a");
  });

  it("delete asks first; Vazgeç leaves the card alone", () => {
    const onDelete = vi.fn(async () => {});
    render(<CardBar card={card} projectName="Alfa" onDelete={onDelete} />);
    fireEvent.click(button(defaultCardBarText.remove));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(button(defaultCardBarText.cancel));
    expect(onDelete).not.toHaveBeenCalled();
    expect(button(defaultCardBarText.remove)).toBeTruthy();
  });

  it("a refused delete shows the engine's reason as an alert outside the one-line group and offers delete again", async () => {
    const onDelete = vi.fn(async () => {
      throw new Error("Commit edilmemiş değişiklikler var: src/a.ts");
    });
    render(<CardBar card={card} projectName="Alfa" onDelete={onDelete} />);
    fireEvent.click(button(defaultCardBarText.remove));
    fireEvent.click(button(defaultCardBarText.confirm));
    await act(async () => {});
    expect(onDelete).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Commit edilmemiş değişiklikler var: src/a.ts");
    expect(bar().contains(alert)).toBe(false);
    expect(button(defaultCardBarText.remove)).toBeTruthy();
  });
});
