import React from 'react';
import styles from './KeyAdvantages.module.scss';
import { Origami1 } from '@/shared/icons/Origami1';
import { Origami2 } from '@/shared/icons/Origami2';
import { Origami3 } from '@/shared/icons/Origami3';
import { Origami4 } from '@/shared/icons/Origami4';
import { Origami5 } from '@/shared/icons/Origami5';
import { Origami6 } from '@/shared/icons/Origami6';
import { Origami7 } from '@/shared/icons/Origami7';
import { Origami8 } from '@/shared/icons/Origami8';
import Container from '@/shared/ui/Container';

const advantages = [

  { 

    title: 'РАБОТАЕМ <br/> С 2010 ГОДА', 
    desc: 'С 2010 года мы уверенно подтверждаем статус надежного партнера и поставщика для более чем 1000 компаний в России и СНГ.' 

  },

  { 

    title: 'ДОСТАВКА <br/> ОТ 1 дня', 
    desc: 'Собственная транспортная компания, располагающая более чем 100 грузовыми автомобилями, что позволяет нам своевременно и оперативно выполнять заказы клиентов.' 

  },

  { 

    title: 'Эксклюзивные бренды', 
    desc: 'Наша экспертиза, богатый опыт, глубокие знания и понимание трендов холодильной отрасли позволяют нам отбирать только лучшие предложения от мировых производителей для решения ваших технических задач. Со многими производителями мы работаем на эксклюзивных условиях. Подробнее смотрите в разделе портфель брендов.' 

  },

  { 

    title: 'Гибкие <br/> условия', 
    desc: 'В число наших партнеров входят как крупнейшие производители холодильного оборудования в России, так и небольшие сервисные компании. Под каждую задачу и под каждый объем мы даем выгодные условия и цены.'

  },

  { 

    title: 'ЭКСПЕРТЫ ОТРАСЛИ', 
    desc: 'Команда, обладающая глубокой экспертизой в индустрии, что позволяет нам не просто поставлять компоненты, но и предлагать клиентам комплексные решения, разрабатывать технические задания для производителей компонентов, адаптированные под российский рынок, подбирать технически верные аналоги.' 

  },

  { 

    title: 'ПОЛНАЯ <br/> ГАРАНТИЯ', 
    desc: 'Мы берем на себя полную ответственность за каждый заказ и гарантируем индивидуальный подход к каждому партнеру.' 

  },

  { 

    title: 'B2B <br/> СЕГМЕНТ', 
    desc: 'Работаем в B2B сегменте, исключая продажи конечному потребителю.' 

  },

  { 

    title: 'доверие и <br/> репутация', 
    desc: 'Нас выбирают за экспертизу, честный подход к партнерским отношениям и стабильность поставок.' 

  }

];

function renderWithBr( str: string ) {

  return str.split('<br/>').map( ( part: string, idx: number, arr: string[] ) => (

    <React.Fragment key={idx}>

      { part }
      { idx < arr.length - 1 && <br /> }

    </React.Fragment>

  ) );

}

const origamiIcons = [

  Origami1,
  Origami2,
  Origami3,
  Origami4,
  Origami5,
  Origami6,
  Origami7,
  Origami8,

];

export const KeyAdvantages = () => ( 

  <section className = { styles.keyAdvantages }> 

    <Container>

      <h2>Ключевые<br/> <span>Преимущества</span></h2>

      <div className = { styles.grid }>

        { advantages.map( (item, idx) => {
  
          const Icon = origamiIcons[ idx ];
          const isRect = [ 2, 3, 4, 5 ].includes( idx );

          return (

            <div

              key = { idx }
              className = { `${styles.card} ${isRect ? styles.rect : styles.square} ${isRect ? styles.minHeightRect : ''}` }

            >
              <div className = { styles.cardTitle }>{ renderWithBr(item.title)  }</div>
              <div className = { styles.cardDesc }>{ item.desc }</div>
              <div className = { styles.cardIcon }><Icon className={`${styles.cardIconSvg} ${styles['icon' + (idx + 1)]}`} /></div>
              
            </div>

          );

        } ) }

      </div>

    </Container>

  </section>

);