"use client";

import styles from "./Header.module.scss";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { phoneHref } from "@/shared/lib/phone";
import { useSiteSettings } from "@/shared/lib/useSiteSettings";

const BurgerMenu = dynamic(() => import("../BurgerMenu/BurgerMenu"), {
  loading: () => null,
  ssr: false,
});

const menuItems = ["Главная", "Каталог", "Климатика", "О нас", "Контакты", "Новости", "Кабинет"];

const Header = () => {

  const [burgerOpen, setBurgerOpen] = useState(false);
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
    if (pathname?.startsWith("/login") || pathname?.startsWith("/cabinet") || pathname?.startsWith("/admin")) return "Кабинет";
    if (pathname !== "/") return null;
    return "Главная";

  };

  const activeItem = getActiveItem();

  const scrollToId = (id: string) => {

    const el = document.querySelector(id);

    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });

  };

  const idMap: Record<string, `#${string}`> = {

    Главная: "#top",
    Новости: "#news",

  };

  return (

    <header className={styles.header}>

      <div className={styles.container}>

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

          <nav className={styles.menu}>

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

              if (item === "Кабинет")

                return (

                  <Link

                    key={item}
                    href="/login"
                    prefetch={false}
                    className={activeItem === item ? styles.active : ""}

                  >

                    {item}

                  </Link>

                );

              // «Новости»
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

              <a href={phoneHref(phone)} className={styles.phoneLink}>
                

                <span className={styles.phoneButton}>{phone}</span>

              </a>

            ) : (

              <span className={styles.phoneButton}>{phone}</span>

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

      </div>

    </header>

  );

};

export default Header;
