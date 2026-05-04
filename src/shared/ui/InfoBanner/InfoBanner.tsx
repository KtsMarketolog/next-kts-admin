import Link from 'next/link';
import Container from '@/shared/ui/Container';
import Button from '@/shared/ui/Button/Button';
import buttonStyles from '@/shared/ui/Button/Button.module.scss';
import styles from './InfoBanner.module.scss';

type ButtonVariant = React.ComponentProps<typeof Button>['variant'];

type BannerButton = {

  label: string;
  href: string;
  variant?: ButtonVariant;

};

type InfoBannerProps = {

  id?: string;
  title: string;
  description: string;
  buttons?: BannerButton[];
  className?: string;
  variant?: 'team' | 'uniray' | string;

};

const DEFAULT_BUTTONS: BannerButton[] = [

  { label: 'Оставить заявку', href: '/contacts', variant: 'secondary' as ButtonVariant },

];

export const InfoBanner = ({

  id,
  title,
  description,
  buttons = DEFAULT_BUTTONS,
  className,
  variant = 'team',

}: InfoBannerProps) => {

  return (

    <section className={`${styles.banner} ${className ?? ''}`} id={id}>

      <div className={styles.bgGradient} data-variant={variant}>

        <Container>

          <div className={styles.content}>

            <h2 className={styles.title}>{title}</h2>

            <span className={styles.desc}>{description}</span>

            <div className={styles.buttons}>

              {buttons.map((btn) => {

                const v = btn.variant ?? ('secondary' as ButtonVariant);

                const variantClass =
                  v === 'secondary'
                    ? buttonStyles.secondary
                    : v === 'primary'
                      ? buttonStyles.primary
                      : buttonStyles.secondary;

                return (

                  <Link

                    key={`${btn.href}-${btn.label}`}
                    href={btn.href}
                    className={`${buttonStyles.button} ${variantClass} ${styles.buttonLinkFix}`}

                  >

                    {btn.label}

                  </Link>

                );

              })}

            </div>

            <div className={styles.icon} aria-hidden="true" />

          </div>

        </Container>

      </div>

    </section>

  );

};