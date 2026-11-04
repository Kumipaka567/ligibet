import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AviatorComponent } from './aviator';
import { provideRouter } from '@angular/router';

describe('AviatorComponent', () => {
  let component: AviatorComponent;
  let fixture: ComponentFixture<AviatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AviatorComponent],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        provideHttpClientTesting()
      ]
    }).overrideComponent(AviatorComponent, {
      set: { template: '<div>Aviator</div>' }
    }).compileComponents();

    fixture = TestBed.createComponent(AviatorComponent);
    component = fixture.componentInstance;
  }, 30000);

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
