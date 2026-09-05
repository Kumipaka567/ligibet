import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Aviator } from './aviator';

describe('Aviator', () => {
  let component: Aviator;
  let fixture: ComponentFixture<Aviator>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Aviator],
    }).compileComponents();

    fixture = TestBed.createComponent(Aviator);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
