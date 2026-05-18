"use client";

import BurgerMenu from "../BurgerMenu/BurgerMenu";
import Button from '@/shared/ui/Button/Button';
import Container from '@/shared/ui/Container';
import styles from "./Header.module.scss";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { phoneHref } from "@/shared/lib/phone";
import { useSiteSettings } from "@/shared/lib/useSiteSettings";

const menuItems = ["Главная", "Каталог", "Климатика", "О нас", "Контакты", "Новости", "Акции"];

const Header = () => {

  const menuRef = useRef<HTMLDivElement | null>(null);
  const [burgerOpen, setBurgerOpen] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const pathname = usePathname();
  const [isMobile, setIsMobile] = useState(false);
  const { phone } = useSiteSettings();

  useEffect(() => {

    const checkMobile = () => setIsMobile(window.innerWidth <= 450);

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);

  }, []);

  const getActiveItem = () => {

    if (pathname?.startsWith("/catalog")) return "Каталог";
    if (pathname === "/about") return "О нас";
    if (pathname === "/contacts") return "Контакты";
    if (pathname === "/klimatika") return "Климатика";
    if (pathname !== "/") return null;
    return "Главная";

  };

  const activeItem = getActiveItem();

  useEffect(() => {

  const menuEl = menuRef.current;

  if (!menuEl) return;

  const updateIndicator = () => {

    const activeLink = menuEl.querySelector(`a.${styles.active}`) as HTMLElement | null;

    if (!activeLink) {

      menuEl.style.setProperty("--active-left", "0px");
      menuEl.style.setProperty("--active-width", "0px");

      return;

    }

    const menuRect = menuEl.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();

    const left = linkRect.left - menuRect.left;
    const width = linkRect.width;

    menuEl.style.setProperty("--active-left", `${left}px`);
    menuEl.style.setProperty("--active-width", `${width}px`);

  };

  requestAnimationFrame(updateIndicator);

  window.addEventListener("resize", updateIndicator);

  return () => window.removeEventListener("resize", updateIndicator);

  }, [pathname]);

  useEffect(() => {

    const onScroll = () => setAtTop(window.scrollY <= 2);

    if (window.scrollY > 2) setAtTop(false);

    window.addEventListener("scroll", onScroll);

    return () => window.removeEventListener("scroll", onScroll);

  }, []);

  const scrollToId = (id: string) => {

    const el = document.querySelector(id);

    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });

  };

  const idMap: Record<string, `#${string}`> = {

    Главная: "#top",
    Новости: "#news",
    Акции: "#sales",

  };

  return (

    <header className={`${styles.header} ${atTop ? styles.transparent : ""}`}>

      <Container>

        <div className={styles.headerInner}>

          <button

            className={styles.burgerBtn}
            aria-label="Открыть меню"
            onClick={() => setBurgerOpen(true)}

          >

            <span /><span /><span />

          </button>

          <Link

            href="/"
            prefetch={false}
            className={styles.logo}
            aria-label="На главную"

            onClick={(e) => {

              if (pathname === "/") {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }

            }}

          >

            <img src="/img/logo.svg" alt="Логотип" width={208} height={65} />

          </Link>

          <nav className={styles.menu} ref={menuRef}>

            {menuItems.map((item) => {

              if (item === "Главная")

                return (

                  <Link

                    key={item}
                    href="/"
                    prefetch={false}
                    className={activeItem === item ? styles.active : ""}

                  >

                    {item}

                  </Link>

                );

              if (item === "Каталог")

                return (

                  <Link

                    key={item}
                    href="/catalog"
                    prefetch={false}
                    className={activeItem === item ? styles.active : ""}

                  >

                    {item}

                  </Link>

                );

              // if (item === "Климатика")

              //   return (

              //     <Link

              //       key={item}
              //       href="/klimatika"
              //       className={activeItem === item ? styles.active : ""}

              //     >

              //       {item}

              //     </Link>

              //   );

              if (item === "Климатика")

                return (

                  <Link
                    key={item}
                    href="/klimatika"
                    prefetch={false}
                    className={activeItem === item ? styles.active : ""}
                  >
                    {item}
                  </Link>

                );



              if (item === "О нас")

                return (

                  <Link

                    key={item}
                    href="/about"
                    prefetch={false}
                    className={activeItem === item ? styles.active : ""}

                  >

                    {item}

                  </Link>

                );

              if (item === "Контакты")

                return (

                  <Link

                    key={item}
                    href="/contacts"
                    prefetch={false}
                    className={activeItem === item ? styles.active : ""}

                  >

                    {item}

                  </Link>

                );

              // «Новости» / «Акции»
              const hash = idMap[item];

              return (

                <Link

                  key={item}
                  href={`/${hash ?? ""}`}
                  prefetch={false}
                  className={activeItem === item ? styles.active : ""}
                  onClick={(e) => {

                    if (pathname === "/" && hash) {

                      e.preventDefault();
                      scrollToId(hash);

                    }

                  }}

                >

                  {item}

                </Link>

              );

            })}

          </nav>

          <div className={styles.phonePosition}>

            {isMobile ? (

              <a href={phoneHref(phone)}>
                

                <Button variant="primary">{phone}</Button>

              </a>

            ) : (

              <Button variant="primary">{phone}</Button>

            )}

          </div>

        </div>

        {burgerOpen && (
          <BurgerMenu
            open={burgerOpen}
            onClose={() => setBurgerOpen(false)}
            menuItems={menuItems}
          />
        )}

      </Container>

    </header>

  );

};

export default Header;
