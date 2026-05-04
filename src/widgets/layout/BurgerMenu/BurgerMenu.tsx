import styles from './BurgerMenu.module.scss';
import { useEffect, useRef  } from "react";
import { useRouter, usePathname } from 'next/navigation'; // ← добавить


type BurgerMenuProps = {

  open: boolean;
  onClose: () => void;
  menuItems: string[];
  activeIndex?: number;

};

export default function BurgerMenu({ open, onClose, menuItems, activeIndex = -1, }: BurgerMenuProps) {

  const router = useRouter();
  const pathname = usePathname();

  const idMap: Record<string, string> = {

    'Главная': '#top',
    'Новости': '#news',
    'Акции': '#sales',

  };

  const scrollToId = (id: string) => {

    const element = document.querySelector(id);

    if (element) {

      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {

        history.replaceState(null, '', window.location.pathname);

      }, 500);

    }

  };

  const handleClick = (item: string) => () => {

    if (item === "Климатика") {

      router.push("/klimatika");
      onClose();
      return;

    }

    if (item === 'О нас') {

      router.push('/about');
      onClose();
      return;

    }

    if (item === 'Контакты') {

      router.push('/contacts');
      onClose();
      return;

    }

    if (item === 'Каталог') {

      router.push('/catalog');
      onClose();
      return;
      
    }

    if (item === 'Главная') {

      router.push('/');
      onClose();
      return;

    }

    const anchor = idMap[item];

    if (anchor) {

      if (pathname !== '/') {

        router.push(`/${anchor}`);
        setTimeout(() => history.replaceState(null, '', '/'), 1000);

      } else {

        scrollToId(anchor);

      }

    }

    onClose();

  };

   const handleLogoClick = () => {
    router.push('/');
    onClose();
  };

  return (

    <div className = { `${styles.overlay} ${open ? styles.open : ''}` }>

      <div className = { styles.menu }>

        <div className = { styles.header }>

          <button type="button" className={styles.logo} onClick={handleLogoClick}>
            
            <img src="/img/logo.svg" alt="Логотип" />

          </button>

          <img src="/img/exit.svg" alt="Закрыть" className = { styles.closeBtn } onClick = { onClose } />

        </div>

        <nav>

          { menuItems.map((item, idx) => (

            <button

              key = { item }
              type = "button"
              className = {`${styles.link} ${idx === activeIndex ? styles.active : ""}`}
              onClick = { handleClick(item) }

            >

              { item }
            </button>

          )) }

          <div className = { styles.infoWrap }>

            <a href="tel:+79648609010" className = { styles.number }>+7 964 860 90 10</a>

             <a 

              href = "https://t.me/your_channel" 
              target = "_blank" 
              rel = "noopener noreferrer"
              className = { styles.tgIcon }

            >

              <img src="/img/social/tg.svg" alt="Telegram" />

            </a>
             
          </div>

        </nav>

      </div>

    </div>

  );

}