import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Category } from '../../core/models/category.model';
import { CategoriesService } from '../../core/services/categories.service';
import { CategoryAnalyticsPageComponent } from './category-analytics-page.component';

const CAIXAS: Category = { id: 1, name: 'Caixas', displayOrder: 0 };

describe('CategoryAnalyticsPageComponent', () => {
  let fixture: ComponentFixture<CategoryAnalyticsPageComponent>;
  let loadedSignal: WritableSignal<boolean>;
  let list: jasmine.Spy;

  const setup = (categoryId: string): void => {
    fixture = TestBed.createComponent(CategoryAnalyticsPageComponent);
    fixture.componentRef.setInput('categoryId', categoryId);
    fixture.detectChanges();
  };

  beforeEach(() => {
    loadedSignal = signal(false);
    list = jasmine.createSpy('list').and.returnValue(of([]));

    TestBed.configureTestingModule({
      imports: [CategoryAnalyticsPageComponent],
      providers: [
        {
          provide: CategoriesService,
          useValue: {
            byId: signal(new Map<number, Category>()).asReadonly(),
            loaded: loadedSignal.asReadonly(),
            list,
          },
        },
      ],
    });
  });

  it('loads the catalog when it is not yet loaded, to resolve the title', () => {
    setup('1');
    expect(list).toHaveBeenCalled();
  });

  it('does not refetch the catalog when it is already loaded', () => {
    loadedSignal.set(true);
    setup('1');
    expect(list).not.toHaveBeenCalled();
  });

  it('shows the resolved category name when the catalog knows it', () => {
    TestBed.overrideProvider(CategoriesService, {
      useValue: {
        byId: signal(new Map([[1, CAIXAS]])).asReadonly(),
        loaded: signal(true).asReadonly(),
        list,
      },
    });
    setup('1');

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Caixas');
  });

  it('falls back to the id while the category is unresolved', () => {
    setup('7');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Categoria #7');
  });
});
