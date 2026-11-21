import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BarList,
  formatCount,
  niceMax,
  StackedColumns,
  StatTile,
} from "@/components/charts";

afterEach(cleanup);

const SERIES = [
  { key: "succeeded", label: "Succeeded", color: "red" },
  { key: "refused", label: "Refused", color: "blue" },
];

describe("number helpers", () => {
  it("rounds axis maxima up to 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(240)).toBe(250);
    expect(niceMax(4100)).toBe(5000);
  });

  it("writes counts in full below ten thousand, compact above", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(12_900)).toBe("12.9K");
  });
});

describe("StatTile", () => {
  it("says how the value changed, in words", () => {
    render(
      <StatTile
        label="Calls"
        value={30}
        previous={20}
        trend={[1, 2, 3]}
        period="the previous 7 days"
      />,
    );
    expect(screen.getByText("Up 50% from the previous 7 days")).toBeTruthy();
  });

  it("marks a rise as bad when up is bad, and handles a zero start", () => {
    const { container } = render(
      <StatTile
        label="Refused"
        value={4}
        previous={0}
        trend={[0, 4]}
        period="the previous 7 days"
        upIsGood={false}
      />,
    );
    expect(screen.getByText("Up from 0 in the previous 7 days")).toBeTruthy();
    expect(
      container.querySelector(".stat-delta")?.getAttribute("data-tone"),
    ).toBe("bad");
  });
});

describe("StackedColumns", () => {
  const columns = [
    {
      label: "Nov 14",
      fullLabel: "Fri, Nov 14",
      values: { succeeded: 3, refused: 1 },
    },
    {
      label: "Nov 15",
      fullLabel: "Sat, Nov 15",
      values: { succeeded: 5, refused: 0 },
    },
  ];

  it("reads each day from the keyboard", () => {
    render(
      <StackedColumns
        title="Calls per day"
        columns={columns}
        series={SERIES}
      />,
    );
    const chart = screen.getByRole("group", { name: /Calls per day/ });
    fireEvent.focus(chart);
    const readout = () =>
      chart.querySelector(".chart-tooltip-title")?.textContent;
    expect(readout()).toBe("Sat, Nov 15");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(readout()).toBe("Fri, Nov 14");
    expect(chart.querySelector(".chart-tooltip")?.textContent).toContain(
      "3Succeeded",
    );
    fireEvent.blur(chart);
    expect(readout()).toBeUndefined();
  });

  it("has every value in a table too", () => {
    render(
      <StackedColumns
        title="Calls per day"
        columns={columns}
        series={SERIES}
      />,
    );
    const table = screen.getByRole("table", { hidden: true });
    expect(table.textContent).toContain("Fri, Nov 14");
    expect(table.textContent).toContain("Succeeded");
  });
});

describe("BarList", () => {
  it("shows names as text and the total at each bar", () => {
    render(
      <BarList
        title="Calls per connection"
        series={SERIES}
        items={[
          {
            label: "<img src=x onerror=alert(1)>",
            values: { succeeded: 2, refused: 1 },
          },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Calls per connection" });
    expect(list.querySelector("img")).toBeNull();
    expect(list.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(list.textContent).toContain("3");
  });
});
