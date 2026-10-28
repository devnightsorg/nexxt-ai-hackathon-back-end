-- Onboarding situation answers (1:1 with User) used by the money map.
CREATE TABLE "SituationProfile" (
    "userId" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SituationProfile_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "SituationProfile" ADD CONSTRAINT "SituationProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
