import { useEffect, type RefObject } from "react";
import { issuePath, opensElsewhere } from "../deep-links";

const LINK_CLASS = "one-card-link";

/**
 * Gives every shared Kanbus card or list row inside `root` a real link to its lead page. The shared
 * collection renders cards that only respond to clicks; until it takes a link address itself, a link that
 * covers each card is added beside the card's own content, which React never reconciles.
 */
export function linkIssueCards(root: HTMLElement): void {
  for (const card of root.querySelectorAll<HTMLElement>(".issue-card[data-issue-id]")) {
    const href = issuePath(card.dataset.issueId ?? "");
    const existing = card.querySelector<HTMLAnchorElement>(`:scope > a.${LINK_CLASS}`);
    if (existing) {
      if (existing.getAttribute("href") !== href) existing.setAttribute("href", href);
      continue;
    }
    const link = document.createElement("a");
    link.className = LINK_CLASS;
    link.setAttribute("href", href);
    link.tabIndex = -1; // The card itself is the keyboard target and opens the same page on Enter.
    link.setAttribute("aria-label", `Open ${card.querySelector("h3")?.textContent ?? "lead"}`);
    card.appendChild(link);
  }
}

/** Keeps `linkIssueCards` applied as the collection renders, and routes plain clicks through the app. */
export function useIssueCardLinks(
  root: RefObject<HTMLElement | null>,
  loaded: boolean,
  onOpen: (issueId: string) => void,
): void {
  useEffect(() => {
    const element = root.current;
    if (!element || !loaded) return;
    linkIssueCards(element);
    const observer = new MutationObserver(() => linkIssueCards(element));
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-issue-id"],
    });
    function click(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(`a.${LINK_CLASS}`);
      if (!link || !element?.contains(link)) return;
      // The card's own click handler must not also run for a click on its link.
      event.stopPropagation();
      if (opensElsewhere(event)) return;
      event.preventDefault();
      const id = link.closest<HTMLElement>("[data-issue-id]")?.dataset.issueId;
      if (id) onOpen(id);
    }
    element.addEventListener("click", click, true);
    return () => {
      observer.disconnect();
      element.removeEventListener("click", click, true);
    };
  }, [root, loaded, onOpen]);
}
