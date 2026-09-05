import { TestBed } from '@angular/core/testing';

import { AdminSocket } from './admin-socket';

describe('AdminSocket', () => {
  let service: AdminSocket;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AdminSocket);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
