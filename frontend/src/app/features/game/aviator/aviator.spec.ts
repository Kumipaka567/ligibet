import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AviatorComponent } from './aviator';

describe('AviatorComponent', () => {
  let component: AviatorComponent;
  let fixture: ComponentFixture<AviatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AviatorComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    }).overrideComponent(AviatorComponent, {
      set: { template: '<div>Aviator</div>' }
    }).compileComponents();

    fixture = TestBed.createComponent(AviatorComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
