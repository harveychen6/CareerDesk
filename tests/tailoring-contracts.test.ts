import { expect, it } from 'vitest'
import { EvidenceProvenanceSchema, ResumeDocumentV1Schema } from '@/domain/tailoring'
it('rejects ungrounded evidence, invalid status, and unknown document properties',()=>{
  expect(EvidenceProvenanceSchema.safeParse({kind:'evidence',factId:null,materialId:null,sourceText:'',status:'confirmed'}).success).toBe(false)
  expect(EvidenceProvenanceSchema.safeParse({kind:'legacy',factId:null,materialId:null,sourceText:'',status:'invented'}).success).toBe(false)
  expect(ResumeDocumentV1Schema.safeParse({version:1,pageTarget:1,profile:null,job:null,summary:'',projects:[],extra:true}).success).toBe(false)
})
