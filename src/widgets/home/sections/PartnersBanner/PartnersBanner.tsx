'use client';

import Button from '@/shared/ui/Button/Button';
import Container from '@/shared/ui/Container';
import styles from './PartnersBanner.module.scss';
import Link from 'next/link';

export const PartnersBanner = () => {

  return (

    <section className = { styles.partnersBanner } id = "cooperation">

      <div className = { styles.bgGradient }>

        <Container>

          <div className = { styles.content }>

            <span className = { styles.subTitle }>Условия для дилеров</span>

            <h2 className = { styles.title }>

              Индивидуальный расчёт под ваш <br />проект

            </h2>

            <span className = { styles.desc }>
              
              Заполните форму — подберем оборудование и подготовим точное КП с
              учетом всех требований

            </span>

            <div className = { styles.buttons }>

              <Link href = "/contacts">

                <Button variant = "secondary">Оставить заявку</Button>

              </Link>

            </div>

          </div>

        </Container>

      </div>

    </section>

  );

};