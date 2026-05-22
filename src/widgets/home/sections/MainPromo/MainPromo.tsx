import { DEFAULT_HERO_SLIDES, type HeroSlide } from "@/entities/site/model/defaultSlides";
import { getHeroImagePropsSet } from "./MainPromo.images";
import { MainPromoEnhancerLoader } from "./MainPromoEnhancerLoader";

type MainPromoProps = {
  initialSlides?: HeroSlide[];
};

type CriticalSlide = {
  id: string;
  title: string;
  imageUrl: string;
  tabletImageUrl: string | null;
  mobileImageUrl: string | null;
  linkUrl: string | null;
  hasPopup: boolean;
};

const mainPromoCriticalCss = `
.kts-main-promo{cursor:default;justify-content:center;padding-top:min(6.97189vw,134px);display:flex;position:relative}
.kts-main-promo__container{width:100%;max-width:min(83.2464vw,1600px);margin-left:auto;margin-right:auto;padding-left:min(.936522vw,18px);padding-right:min(.936522vw,18px)}
.kts-main-promo__track{scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;gap:min(2.08116vw,40px);display:flex;overflow-x:auto}
.kts-main-promo__track::-webkit-scrollbar{display:none}
.kts-main-promo__slide{scroll-snap-align:start;box-sizing:border-box;flex:0 0 100%;display:flex}
.kts-main-promo__visual{isolation:isolate;background:#f2f0ff linear-gradient(110deg,#f2f0ff 0%,#fbfaff 48%,#e7e4ff 100%);background-position:min(.052029vw,1px);background-repeat:no-repeat;background-size:cover;border-radius:min(2.08116vw,40px);flex:1;align-items:stretch;height:100%;min-height:min(37.5649vw,722px);padding:min(2.08116vw,40px);display:flex;position:relative;overflow:hidden;color:inherit;text-decoration:none}
.kts-main-promo__visual:before,.kts-main-promo__visual:after{content:"";position:absolute;z-index:0;pointer-events:none;will-change:transform,opacity}
.kts-main-promo__visual:before{inset:-40% -55%;background:radial-gradient(circle at 30% 50%,rgb(255 255 255 / 74%),transparent 30%),linear-gradient(110deg,rgb(255 255 255 / 0%) 20%,rgb(141 129 196 / 18%) 36%,rgb(255 255 255 / 88%) 48%,rgb(183 174 235 / 24%) 58%,rgb(255 255 255 / 0%) 76%);filter:blur(26px) saturate(1.08);opacity:.42;transform:translate3d(-58%,0,0) rotate(4deg);animation:ktsMainPromoSkeletonSweep 2.8s ease-in-out infinite}
.kts-main-promo__visual:after{top:8%;bottom:8%;left:-34%;width:30%;border-radius:999px;background:radial-gradient(ellipse at center,rgb(255 255 255 / 92%) 0%,rgb(210 203 250 / 52%) 34%,rgb(255 255 255 / 0%) 74%);filter:blur(19px);opacity:.4;transform:translate3d(-135%,0,0) rotate(15deg);animation:ktsMainPromoSkeletonSparkle 3.22s ease-in-out infinite}
.kts-main-promo__visual:hover,.kts-main-promo__visual:focus{color:inherit}
.kts-main-promo__visual--clickable{cursor:pointer}
.kts-main-promo__picture,.kts-main-promo__img{object-fit:cover;object-position:min(.052029vw,1px) center;z-index:1;width:100%;height:100%;display:block;position:absolute;inset:0}
.kts-main-promo__pagination-shell{justify-content:center;align-items:center;min-height:min(.728406vw,14px);margin-top:min(1.66493vw,32px);display:flex}
.kts-main-promo__pagination{justify-content:center;gap:min(.832464vw,16px);display:flex}
.kts-main-promo__dot{background-color:#d9d9d9;border-radius:50%;width:min(.728406vw,14px);height:min(.728406vw,14px);transition:all .3s}
.kts-main-promo__dot--active{background-color:#333;border-radius:min(2.60145vw,50px);width:min(3.64203vw,70px)}
@keyframes ktsMainPromoSkeletonSweep{0%{transform:translate3d(-58%,0,0) rotate(4deg)}55%,100%{transform:translate3d(58%,0,0) rotate(4deg)}}
@keyframes ktsMainPromoSkeletonSparkle{0%,30%{transform:translate3d(-135%,0,0) rotate(15deg)}72%,100%{transform:translate3d(650%,0,0) rotate(15deg)}}
@media (prefers-reduced-motion:reduce){
  .kts-main-promo__visual:before{animation:none;transform:translate3d(0,0,0) rotate(4deg)}
  .kts-main-promo__visual:after{animation:none;opacity:.18;transform:translate3d(0,0,0) rotate(15deg)}
}
@media (max-width:1024px){
  .kts-main-promo{margin-bottom:0;padding-top:16.3023vw}
  .kts-main-promo__container{max-width:98.2112vw;padding-left:.198808vw;padding-right:.198808vw}
  .kts-main-promo__visual{border-radius:3.97616vw;min-height:71.7697vw;padding:3.97616vw}
  .kts-main-promo__dot{width:1.39166vw;height:1.39166vw}
  .kts-main-promo__dot--active{width:6.95828vw}
}
@media (max-width:450px){
  .kts-main-promo{margin-bottom:10vw;padding-top:27.5vw}
  .kts-main-promo__container{max-width:100vw;padding-left:2vw;padding-right:2vw}
  .kts-main-promo__track{gap:4vw;min-height:102vw}
  .kts-main-promo__visual{border-radius:7.5vw;min-height:102vw;padding:10vw 5vw 7.5vw}
  .kts-main-promo__img{object-fit:cover;width:100%;height:102vw}
  .kts-main-promo__pagination-shell{min-height:2vw;margin-top:5vw}
  .kts-main-promo__pagination{gap:3vw}
  .kts-main-promo__dot{width:2vw;height:2vw}
  .kts-main-promo__dot--active{width:12.5vw}
}
`;

function getCriticalSlides(initialSlides?: HeroSlide[]): CriticalSlide[] {
  const managedSlides = Array.isArray(initialSlides)
    ? initialSlides.filter((slide) => typeof slide.imageUrl === "string" && slide.imageUrl)
    : [];

  const slides = managedSlides.length
    ? managedSlides
    : DEFAULT_HERO_SLIDES.map((slide, index) => ({ ...slide, id: index + 1 }));

  return slides.map((slide) => ({
    id: String(slide.id),
    title: slide.title || "",
    imageUrl: slide.imageUrl,
    tabletImageUrl: slide.tabletImageUrl || slide.imageUrl,
    mobileImageUrl: slide.mobileImageUrl || slide.tabletImageUrl || slide.imageUrl,
    linkUrl: slide.linkUrl,
    hasPopup: Boolean(
      slide.popupImageUrl ||
      slide.popupTabletImageUrl ||
      slide.popupMobileImageUrl ||
      slide.popupTitle ||
      slide.popupText
    ),
  }));
}

function MainPromoCriticalSlide({ slide }: { slide: CriticalSlide }) {
  const clickable = Boolean(slide.linkUrl || slide.hasPopup);
  const { desktop: desktopImage, tablet: tabletImage, mobile: mobileImage } = getHeroImagePropsSet({
    desktop: slide.imageUrl,
    tablet: slide.tabletImageUrl,
    mobile: slide.mobileImageUrl,
    loading: "eager",
    decoding: "sync",
    fetchPriority: "high",
  });

  const image = (
    <picture className="kts-main-promo__picture">
      <source
        media="(max-width: 450px)"
        srcSet={mobileImage.srcSet ?? mobileImage.src}
        sizes={mobileImage.sizes}
      />
      <source
        media="(max-width: 1024px)"
        srcSet={tabletImage.srcSet ?? tabletImage.src}
        sizes={tabletImage.sizes}
      />
      <img {...desktopImage} alt="" className="kts-main-promo__img" />
    </picture>
  );

  const visualClassName = `kts-main-promo__visual${clickable ? " kts-main-promo__visual--clickable" : ""}`;

  return (
    <div className="kts-main-promo__slide" data-main-promo-slide="0">
      {slide.linkUrl ? (
        <a
          className={visualClassName}
          href={slide.linkUrl}
          data-main-promo-visual="true"
          data-main-promo-index="0"
          aria-label={slide.title || "Open slide"}
        >
          {image}
        </a>
      ) : (
        <div
          className={visualClassName}
          data-main-promo-visual="true"
          data-main-promo-index="0"
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : -1}
          aria-label={clickable ? slide.title || "Open slide" : undefined}
        >
          {image}
        </div>
      )}
    </div>
  );
}

export const MainPromo = ({ initialSlides }: MainPromoProps) => {
  const slides = getCriticalSlides(initialSlides);
  const firstSlide = slides[0];

  if (!firstSlide) return null;

  return (
    <section className="kts-main-promo" id="top">
      <style dangerouslySetInnerHTML={{ __html: mainPromoCriticalCss }} />
      <div className="kts-main-promo__container">
        <div className="kts-main-promo__track" data-main-promo-track>
          <MainPromoCriticalSlide slide={firstSlide} />
          {slides.slice(1).map((slide, index) => (
            <div
              key={slide.id}
              className="kts-main-promo__slide"
              data-main-promo-slot="true"
              data-main-promo-index={index + 1}
            />
          ))}
        </div>
        {slides.length > 1 && (
          <div className="kts-main-promo__pagination-shell">
            <MainPromoEnhancerLoader initialSlides={initialSlides} count={slides.length} />
          </div>
        )}
      </div>
    </section>
  );
};
