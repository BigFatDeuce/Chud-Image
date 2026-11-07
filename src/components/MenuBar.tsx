import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type MenuItem =
  | { type: "separator" }
  | { type: "label"; label: string }
  | {
      type?: "item";
      label: string;
      shortcut?: string;
      onSelect: () => void;
      disabled?: boolean;
      checked?: boolean;
    };

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(null);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.stopPropagation();
        const i = menus.findIndex((m) => m.id === open);
        const next = (i + (e.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length;
        setOpen(menus[next].id);
      }
    };
    const onBlur = () => setOpen(null);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, menus]);

  return (
    <div className="menubar" ref={ref} role="menubar">
      {menus.map((menu) => (
        <div className="menu" key={menu.id}>
          <button
            className={`menu-trigger${open === menu.id ? " open" : ""}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === menu.id}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onPointerEnter={() => open && open !== menu.id && setOpen(menu.id)}
          >
            {menu.label}
          </button>
          {open === menu.id && (
            <div className="menu-popup" role="menu">
              {menu.items.map((item, i) => {
                if (item.type === "separator") return <div key={i} className="menu-sep" role="separator" />;
                if (item.type === "label") return <div key={i} className="menu-label">{item.label}</div>;
                return (
                  <button
                    key={i}
                    className="menu-item"
                    role={item.checked !== undefined ? "menuitemradio" : "menuitem"}
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.onSelect();
                    }}
                  >
                    <span className="menu-check">{item.checked && <Check size={14} strokeWidth={2.4} />}</span>
                    <span className="menu-text">{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
