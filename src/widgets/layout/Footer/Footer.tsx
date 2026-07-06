'use client';

import { useRouter, usePathname } from 'next/navigation';
import Container from '@/shared/ui/Container';
import styles from './Footer.module.scss';
import Button from '@/shared/ui/Button/Button';
import Link from 'next/link';
import { useSiteSettings } from '@/shared/lib/useSiteSettings';

const footerMenu = {

  main: ['Главная', 'Каталог', 'О нас', 'Преимущества', 'Контакты'],
  extra: ['Сотрудничество', 'Политика конфиденциальности'],

};

const footerHrefMap: Record<string, string> = {

  'Главная': '/#top',
  'Каталог': '/catalog',
  'О нас': '/about',
  'Преимущества': '/#benefits',
  'Контакты': '/contacts',
  'Сотрудничество': '/#cooperation',
  'Политика конфиденциальности': '/#contacts',

};

export const Footer = () => {

  const router = useRouter();
  const pathname = usePathname();
  const { phone, email, address } = useSiteSettings();

  const idMap: Record<string, string> = {

    'Главная': '#top',
    'Преимущества': '#benefits',
    'Сотрудничество': '#cooperation',
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

  const handleFooterClick = (item: string) => (e: React.MouseEvent) => {

    const targetHref = footerHrefMap[item];
    const footerAnchor = idMap[item];
    const directRoute = targetHref === '/about' || targetHref === '/contacts' || targetHref === '/catalog';

    if (!footerAnchor && !directRoute) {
      return;
    }

    e.preventDefault();

    if (directRoute) {
      router.push(targetHref);
      return;
    }

    if (item === 'О нас') {

      router.push('/about');
      return;

    }

    if (item === 'Контакты') {

      router.push('/contacts');
      return;

    }

    if (item === 'Каталог') {
      router.push('/catalog');
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
  };


  return (

    <section className = { styles.footer } id = "contacts">

      <div className = { styles.bgGradient }>

        <Container>

          <div className = { styles.content }>

            <div className = { styles.logo }>

              <img src="/img/logo-footer.svg" alt="Логотип" loading="lazy" decoding="async" />

            </div>

            <ul className = { styles.contactsList }>

              <li><span className = { styles.icon }><img src="/img/contacts/email.svg" alt = "Email" /></span><span>{email}</span></li>
              <li><span className = { styles.icon }><img src="/img/contacts/phone-call.svg" alt = "Телефон" /></span><span>{phone}</span></li>
              <li><span className = { styles.icon }><img src="/img/contacts/home.svg" alt = "Адрес" /></span><span>{address}</span></li>

            </ul>

            <p className = { styles.desc}>Дистрибьютор<br /> холодильных <br /> компонентов</p>

            <div className = { styles.menu}>

              <div className = { styles.col}>

                <span className = { styles.colTitle}>МЕНЮ</span>

                <ul>

                  { footerMenu.main.map(item => (

                    <li key = { item }>

                      <a href={footerHrefMap[item] ?? '/'} onClick = { handleFooterClick(item) }>{ item }</a>

                    </li>

                  )) }

                </ul>

              </div>

              <div className = { styles.col }>

                <span className = { styles.colTitle }>ЕЩЕ</span>

                <ul>

                  { footerMenu.extra.map(item => (

                    <li key = { item }>

                      <a href={footerHrefMap[item] ?? '/'} onClick = { handleFooterClick(item) }>{ item }</a>

                    </li>

                  )) }

                </ul>

              </div>

            </div>

            <div className = { styles.buttonWrapper }>

              <Link href = "/contacts">

                <Button variant = "purple">Написать нам ↗</Button>

              </Link>

            </div>

            <div className = { styles.bottom }>© КТС 2010–2026</div>

          </div>

        </Container>

      </div>

    </section>

  );

};
