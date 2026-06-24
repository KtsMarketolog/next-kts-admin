import { AdminBrandPortfolioSection } from '@/features/admin/brand-portfolio/AdminBrandPortfolioSection';
import { AdminCategoriesSection } from '@/features/admin/categories/AdminCategoriesSection';
import { AdminCatalogSection } from '@/features/admin/catalog/AdminCatalogSection';
import { AdminFirmwareSection } from '@/features/admin/firmware/AdminFirmwareSection';
import { AdminGroupCompaniesSection } from '@/features/admin/group-companies/AdminGroupCompaniesSection';
import { AdminInfoSection } from '@/features/admin/info/AdminInfoSection';
import type { useAdminBrandPortfolio } from '@/features/admin/model/useAdminBrandPortfolio';
import type { useAdminGroupCompanies } from '@/features/admin/model/useAdminGroupCompanies';
import type { useAdminNews } from '@/features/admin/model/useAdminNews';
import type { useAdminPriceGroups } from '@/features/admin/model/useAdminPriceGroups';
import type { useAdminSlides } from '@/features/admin/model/useAdminSlides';
import { AdminNewsSection } from '@/features/admin/news/AdminNewsSection';
import { AdminPriceGroupsSection } from '@/features/admin/price-groups/AdminPriceGroupsSection';
import { AdminSliderSection } from '@/features/admin/slider/AdminSliderSection';
import type { AdminSection, SettingKey } from '@/features/admin/types';
import { AdminUsersSection } from '@/features/admin/users/AdminUsersSection';

type AdminSiteContentProps = {
  activeSection: AdminSection;
  phone: string;
  email: string;
  address: string;
  busy: boolean;
  savedSetting: SettingKey | null;
  slideAdmin: ReturnType<typeof useAdminSlides>;
  newsAdmin: ReturnType<typeof useAdminNews>;
  groupCompanyAdmin: ReturnType<typeof useAdminGroupCompanies>;
  brandAdmin: ReturnType<typeof useAdminBrandPortfolio>;
  priceGroupAdmin: ReturnType<typeof useAdminPriceGroups>;
  onPhoneChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onSaveInfo: (target: SettingKey) => Promise<void>;
  uploadImage: (file: File, kind?: 'image' | 'brandLogo' | 'priceGroup' | 'categoryIcon') => Promise<string>;
  showStatus: (message: string) => void;
};

export function AdminSiteContent({
  activeSection,
  phone,
  email,
  address,
  busy,
  savedSetting,
  slideAdmin,
  newsAdmin,
  groupCompanyAdmin,
  brandAdmin,
  priceGroupAdmin,
  onPhoneChange,
  onEmailChange,
  onAddressChange,
  onSaveInfo,
  uploadImage,
  showStatus,
}: AdminSiteContentProps) {
  return (
    <>
      {activeSection === 'info' && (
        <AdminInfoSection
          phone={phone}
          email={email}
          address={address}
          busy={busy}
          savedSetting={savedSetting}
          onPhoneChange={onPhoneChange}
          onEmailChange={onEmailChange}
          onAddressChange={onAddressChange}
          onSave={onSaveInfo}
        />
      )}

      {activeSection === 'slider' && (
        <AdminSliderSection
          slides={slideAdmin.slides}
          draft={slideAdmin.draft}
          nextSlideOrder={slideAdmin.nextSlideOrder}
          draggedSlideId={slideAdmin.draggedSlideId}
          busy={busy}
          savedSlideId={slideAdmin.savedSlideId}
          setDraft={slideAdmin.setDraft}
          setDraggedSlideId={slideAdmin.setDraggedSlideId}
          updateSlide={slideAdmin.updateSlide}
          moveSlide={slideAdmin.moveSlide}
          createSlide={slideAdmin.createSlide}
          saveSlide={slideAdmin.saveSlide}
          deleteSlide={slideAdmin.deleteSlide}
          uploadImage={uploadImage}
          showStatus={showStatus}
        />
      )}

      {activeSection === 'news' && (
        <AdminNewsSection
          news={newsAdmin.news}
          newsDraft={newsAdmin.newsDraft}
          nextNewsOrder={newsAdmin.nextNewsOrder}
          draggedNewsId={newsAdmin.draggedNewsId}
          busy={busy}
          newsCreated={newsAdmin.newsCreated}
          savedNewsId={newsAdmin.savedNewsId}
          setNewsDraft={newsAdmin.setNewsDraft}
          setDraggedNewsId={newsAdmin.setDraggedNewsId}
          updateNews={newsAdmin.updateNews}
          moveNews={newsAdmin.moveNews}
          createNews={newsAdmin.createNews}
          saveNews={newsAdmin.saveNews}
          deleteNews={newsAdmin.deleteNews}
          uploadImage={uploadImage}
          showStatus={showStatus}
        />
      )}

      {activeSection === 'groupCompanies' && (
        <AdminGroupCompaniesSection
          groupCompanies={groupCompanyAdmin.groupCompanies}
          groupCompanyDraft={groupCompanyAdmin.groupCompanyDraft}
          nextGroupCompanyOrder={groupCompanyAdmin.nextGroupCompanyOrder}
          draggedGroupCompanyId={groupCompanyAdmin.draggedGroupCompanyId}
          busy={busy}
          groupCompanyCreated={groupCompanyAdmin.groupCompanyCreated}
          savedGroupCompanyId={groupCompanyAdmin.savedGroupCompanyId}
          setGroupCompanyDraft={groupCompanyAdmin.setGroupCompanyDraft}
          setDraggedGroupCompanyId={groupCompanyAdmin.setDraggedGroupCompanyId}
          updateGroupCompany={groupCompanyAdmin.updateGroupCompany}
          moveGroupCompany={groupCompanyAdmin.moveGroupCompany}
          createGroupCompany={groupCompanyAdmin.createGroupCompany}
          saveGroupCompany={groupCompanyAdmin.saveGroupCompany}
          deleteGroupCompany={groupCompanyAdmin.deleteGroupCompany}
          uploadImage={uploadImage}
          showStatus={showStatus}
        />
      )}

      {activeSection === 'brands' && (
        <AdminBrandPortfolioSection
          brandCategories={brandAdmin.brandCategories}
          brands={brandAdmin.brands}
          brandCategoryDraft={brandAdmin.brandCategoryDraft}
          brandDraft={brandAdmin.brandDraft}
          draggedBrandCategoryId={brandAdmin.draggedBrandCategoryId}
          busy={busy}
          savedBrandCategoryId={brandAdmin.savedBrandCategoryId}
          savedBrandId={brandAdmin.savedBrandId}
          brandCategoryCreated={brandAdmin.brandCategoryCreated}
          setBrandCategoryDraft={brandAdmin.setBrandCategoryDraft}
          setBrandDraft={brandAdmin.setBrandDraft}
          setDraggedBrandCategoryId={brandAdmin.setDraggedBrandCategoryId}
          updateBrandCategory={brandAdmin.updateBrandCategory}
          moveBrandCategory={brandAdmin.moveBrandCategory}
          createBrandCategoryItem={brandAdmin.createBrandCategoryItem}
          saveBrandCategory={brandAdmin.saveBrandCategory}
          deleteBrandCategoryItem={brandAdmin.deleteBrandCategoryItem}
          updateBrand={brandAdmin.updateBrand}
          createBrand={brandAdmin.createBrand}
          saveBrand={brandAdmin.saveBrand}
          deleteBrand={brandAdmin.deleteBrand}
          uploadImage={(file) => uploadImage(file, 'brandLogo')}
          showStatus={showStatus}
        />
      )}

      {activeSection === 'catalog' && <AdminCatalogSection showStatus={showStatus} />}

      {activeSection === 'firmware' && <AdminFirmwareSection showStatus={showStatus} />}

      {activeSection === 'categories' && (
        <AdminCategoriesSection showStatus={showStatus} uploadImage={(file) => uploadImage(file, 'categoryIcon')} />
      )}

      {activeSection === 'priceGroups' && (
        <AdminPriceGroupsSection
          priceGroups={priceGroupAdmin.priceGroups}
          savedPriceGroupTitle={priceGroupAdmin.savedPriceGroupTitle}
          busy={busy}
          updatePriceGroup={priceGroupAdmin.updatePriceGroup}
          savePriceGroup={priceGroupAdmin.savePriceGroup}
          uploadImage={(file) => uploadImage(file, 'priceGroup')}
          showStatus={showStatus}
        />
      )}

      {activeSection === 'users' && <AdminUsersSection showStatus={showStatus} />}
    </>
  );
}
