import Container from '@/shared/ui/Container';
import styles from "./AboutHero.module.scss";

export const AboutHero = () => {

  return (

    
    <Container>

      <div className = { styles.pad }></div>

      <div className = { styles.bgGradient }>

        <section className = { styles.aboutHero }>

          <h2 className = { styles.title }>

            15 лет делаем<br />рынок холода сильнее

          </h2>

          <p className = { styles.desc }>

            Поставляем проверенные компоненты, открываем новые бренды,
            тестируем технологии в реальных проектах и задаем тренды для
            всей отрасли
            
          </p>
            
        </section>

      </div>

    </Container>


  );

};
